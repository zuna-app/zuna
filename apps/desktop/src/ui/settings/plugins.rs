//! Settings → Plugins: what's installed, each with its switch, its permissions in words, its
//! version and where it came from; Browse, which reads the marketplace's index; and under
//! Advanced, the switch for plugins Zuna hasn't checked, "Install from a file…" and "Load a
//! folder…". Each plugin's own settings are a section of their own under a "Plugins" heading.

use std::collections::HashMap;

use super::*;
use crate::plugins::Plugins;
use crate::plugins::store::Origin;

thread_local! {
    /// The text fields of plugins' settings, by plugin and key.
    static FIELDS: std::cell::RefCell<HashMap<String, (Entity<TextInput>, gpui::Subscription)>> = std::cell::RefCell::new(HashMap::new());
}

/// What a plugin is listed with.
struct Listed {
    uid: String,
    name: String,
    version: String,
    origin: Origin,
    enabled: bool,
    running: bool,
    problem: Option<String>,
    told: Vec<(String, bool)>,
    waiting: Option<String>,
    path: String,
    log: Vec<crate::plugins::LogLine>,
}

fn listed(plugins: &Plugins) -> Vec<Listed> {
    let mut out: Vec<Listed> = plugins
        .record
        .plugins
        .iter()
        .map(|record| {
            let uid = record.uid();
            let loaded = plugins.loaded.get(&uid);
            Listed {
                uid: uid.clone(),
                name: record.name.clone(),
                version: record.version.clone(),
                origin: record.origin,
                enabled: record.enabled,
                running: plugins.running(&uid),
                problem: plugins.problems.get(&uid).cloned().or_else(|| record.off_reason.clone()),
                told: loaded.map(|loaded| loaded.manifest().told()).unwrap_or_default(),
                waiting: plugins.market.waiting.get(&uid).map(|version| version.version.clone()),
                path: record.path.clone(),
                log: plugins.logs.get(&uid).map(|log| log.iter().rev().take(40).rev().cloned().collect()).unwrap_or_default(),
            }
        })
        .collect();
    // Those Zuna hasn't checked are listed apart, first.
    out.sort_by_key(|item| (item.origin == Origin::Verified, item.name.to_lowercase()));
    out
}

impl SettingsView {
    /// The plugins with a section of their own in Settings: those with settings, or a view for them.
    pub(super) fn plugin_sections(cx: &gpui::App) -> Vec<(String, String, bool)> {
        let Some(plugins) = crate::plugins::get(cx) else { return Vec::new() };
        let plugins = plugins.read(cx);
        plugins
            .loaded
            .iter()
            .filter(|(uid, loaded)| loaded.record.enabled && (!loaded.manifest().contributes.settings.is_empty() || plugins.slots.get(*uid).is_some_and(|slots| slots.settings_view)))
            .map(|(uid, loaded)| (uid.clone(), loaded.manifest().name.clone(), loaded.record.verified()))
            .collect()
    }

    fn pick_file(&mut self, cx: &mut Context<Self>) {
        let chosen = cx.prompt_for_paths(gpui::PathPromptOptions { files: true, directories: false, multiple: false, prompt: None });
        cx.spawn(async move |view, cx| {
            let Ok(Ok(Some(paths))) = chosen.await else { return };
            let Some(path) = paths.into_iter().next() else { return };
            view.update(cx, |view, cx| view.propose_file(&path, cx)).ok();
        })
        .detach();
    }

    pub(super) fn propose_file(&mut self, path: &std::path::Path, cx: &mut Context<Self>) {
        let result = match std::fs::metadata(path) {
            Ok(meta) if meta.len() > crate::plugins::package::MAX_PACKAGE as u64 => Err("A plugin's package is at most 8 MB.".to_string()),
            Ok(_) => std::fs::read(path).map_err(|error| error.to_string()),
            Err(error) => Err(error.to_string()),
        };
        let result = result.and_then(|bytes| match crate::plugins::get(cx) {
            Some(plugins) => plugins.update(cx, |plugins, cx| plugins.propose_file(bytes, cx).map(|_| ())),
            None => Err("Plugins aren't ready.".into()),
        });
        if let Err(error) = result {
            self.state.update(cx, |state, cx| state.toast(error, ToastKind::Error, cx));
        }
    }

    fn pick_folder(&mut self, cx: &mut Context<Self>) {
        let chosen = cx.prompt_for_paths(gpui::PathPromptOptions { files: false, directories: true, multiple: false, prompt: None });
        cx.spawn(async move |view, cx| {
            let Ok(Ok(Some(paths))) = chosen.await else { return };
            let Some(dir) = paths.into_iter().next() else { return };
            view.update(cx, |view, cx| {
                let result = match crate::plugins::get(cx) {
                    Some(plugins) => plugins.update(cx, |plugins, cx| plugins.propose_folder(dir, cx)),
                    None => Err("Plugins aren't ready.".into()),
                };
                if let Err(error) = result {
                    view.state.update(cx, |state, cx| state.toast(error, ToastKind::Error, cx));
                }
            })
            .ok();
        })
        .detach();
    }

    fn browse(&mut self, cx: &mut Context<Self>) {
        self.browsing = true;
        if let Some(plugins) = crate::plugins::get(cx) {
            plugins.update(cx, |plugins, cx| plugins.refresh_market(cx));
        }
        cx.notify();
    }

    pub(super) fn plugins_page(&mut self, cx: &mut Context<Self>) -> Vec<AnyElement> {
        let theme = theme(cx);
        let Some(plugins_entity) = crate::plugins::get(cx) else { return vec![Self::heading("Plugins", &theme)] };
        let (items, safe_mode, allow, usable) = {
            let plugins = plugins_entity.read(cx);
            (listed(plugins), plugins.safe_mode.clone(), plugins.record.allow_unverified, plugins.usable())
        };
        let mut parts = vec![
            Self::heading("Plugins", &theme),
            Self::lead("Plugins change what the app does here, on this device alone: no server knows of them. Each runs apart from your keys and asks only for what it was granted.".into(), &theme),
        ];
        if let Some(reason) = safe_mode {
            parts.push(notice("info", reason, cx).into_any_element());
        }
        if !usable {
            parts.push(notice("triangle-alert", "Plugins can't be installed, as this device's key couldn't be read.", cx).into_any_element());
        }
        parts.push(
            div()
                .flex()
                .gap(px(8.))
                .child(button("plugins-browse", ButtonKind::Primary, ButtonSize::Normal, false, cx).child(icon("store", 15., theme.on_accent)).child("Browse").on_click(cx.listener(|view, _, _, cx| view.browse(cx))))
                .into_any_element(),
        );
        if self.browsing {
            parts.extend(self.marketplace(cx));
        }
        parts.push(Self::divider(&theme));
        parts.push(Self::subheading("Installed"));
        if items.is_empty() {
            parts.push(div().text_size(px(13.)).text_color(theme.text2).child("None. Nothing comes with the app, and a device with no plugins never contacts the marketplace.").into_any_element());
        }
        for item in items {
            parts.push(self.installed_row(item, cx));
        }
        parts.push(Self::divider(&theme));
        parts.push(Self::subheading("Advanced"));
        parts.push(Self::row(
            "Allow plugins Zuna hasn't checked",
            Some("Plugins from a file or a folder, which nobody on Zuna's team has read. They wear a mark wherever they show."),
            switch("plugins-unverified", allow, cx).on_click(cx.listener(move |view, _, _, cx| {
                if allow {
                    if let Some(plugins) = crate::plugins::get(cx) {
                        plugins.update(cx, |plugins, cx| plugins.set_allow_unverified(false, cx));
                    }
                } else {
                    view.confirming_unverified = true;
                    cx.notify();
                }
            })),
            &theme,
        ));
        parts.push(
            div()
                .flex()
                .gap(px(8.))
                .child(button("plugins-file", ButtonKind::Default, ButtonSize::Normal, !usable, cx).child("Install from a file…").when(usable, |el| el.on_click(cx.listener(|view, _, _, cx| view.pick_file(cx)))))
                .child(button("plugins-folder", ButtonKind::Default, ButtonSize::Normal, !allow, cx).child("Load a folder…").when(allow, |el| el.on_click(cx.listener(|view, _, _, cx| view.pick_folder(cx)))))
                .into_any_element(),
        );
        parts.push(div().text_size(px(12.5)).text_color(theme.text3).child("A plugin's file can also be dropped here. Nothing in a chat installs one.").into_any_element());
        parts
    }

    fn installed_row(&mut self, item: Listed, cx: &mut Context<Self>) -> AnyElement {
        let theme = theme(cx);
        let uid = item.uid.clone();
        let from = match item.origin {
            Origin::Verified => "Verified by Zuna".to_string(),
            Origin::File => "From a file".to_string(),
            Origin::Folder => format!("From a folder: {}", item.path),
        };
        let status = if item.enabled && item.running {
            "On".to_string()
        } else if item.enabled && item.problem.is_none() {
            "Starting".to_string()
        } else {
            "Off".to_string()
        };
        let (toggle_uid, remove_uid, update_uid, log_uid) = (uid.clone(), uid.clone(), uid.clone(), uid.clone());
        let enabled = item.enabled;
        let showing_log = self.showing_log.as_deref() == Some(uid.as_str());
        div()
            .flex()
            .flex_col()
            .gap(px(8.))
            .p(px(14.))
            .rounded(RADIUS_M)
            .bg(theme.bg1)
            .border_1()
            .border_color(if item.origin == Origin::Verified { theme.line } else { theme.red_soft })
            .child(
                div()
                    .flex()
                    .items_center()
                    .gap(px(10.))
                    .child(icon("puzzle", 18., theme.text2))
                    .child(
                        div()
                            .flex_1()
                            .min_w_0()
                            .flex()
                            .flex_col()
                            .child(div().flex().items_center().gap(px(6.)).child(div().font_weight(FontWeight::MEDIUM).one_line().child(item.name.clone())).when(item.origin != Origin::Verified, |el| el.child(crate::ui::plugins::unverified_mark(cx))))
                            .child(div().text_size(px(12.)).text_color(theme.text3).child(format!("{} · {} · {}", item.version, from, status))),
                    )
                    .child(switch(SharedString::from(format!("plugin-on-{uid}")), enabled, cx).on_click(move |_, _, cx| {
                        if let Some(plugins) = crate::plugins::get(cx) {
                            plugins.update(cx, |plugins, cx| plugins.set_enabled(&toggle_uid, !enabled, cx));
                        }
                    })),
            )
            .when_some(item.problem.clone(), |el, problem| el.child(div().text_size(px(12.5)).text_color(theme.red).child(problem)))
            .child(div().flex().flex_col().gap(px(3.)).children(if item.told.is_empty() {
                vec![div().text_size(px(12.5)).text_color(theme.text2).child("Asks for nothing of your account.").into_any_element()]
            } else {
                item.told.iter().map(|(line, strong)| div().text_size(px(12.5)).text_color(theme.text2).when(*strong, |el| el.font_weight(FontWeight::SEMIBOLD).text_color(theme.text1)).child(format!("• {line}")).into_any_element()).collect()
            }))
            .child(
                div()
                    .flex()
                    .gap(px(8.))
                    .when_some(item.waiting.clone(), |el, version| {
                        el.child(button(SharedString::from(format!("plugin-update-{uid}")), ButtonKind::Primary, ButtonSize::Small, false, cx).child(format!("Update to {version}…")).on_click(move |_, _, cx| {
                            let id = update_uid.split_once(':').map(|(_, id)| id.to_string()).unwrap_or_default();
                            if let Some(plugins) = crate::plugins::get(cx) {
                                let result = plugins.update(cx, |plugins, cx| plugins.propose_market(&id, cx));
                                if let Err(error) = result {
                                    crate::state::store(cx).update(cx, |state, cx| state.toast(error, ToastKind::Error, cx));
                                }
                            }
                        }))
                    })
                    .when(item.origin == Origin::Folder || !item.log.is_empty(), |el| {
                        el.child(button(SharedString::from(format!("plugin-log-{uid}")), ButtonKind::Ghost, ButtonSize::Small, false, cx).child(if showing_log { "Hide log" } else { "Log" }).on_click(cx.listener(move |view, _, _, cx| {
                            view.showing_log = if view.showing_log.as_deref() == Some(log_uid.as_str()) { None } else { Some(log_uid.clone()) };
                            cx.notify();
                        })))
                    })
                    .child(button(SharedString::from(format!("plugin-remove-{uid}")), ButtonKind::Danger, ButtonSize::Small, false, cx).child("Remove").on_click(move |_, _, cx| {
                        if let Some(plugins) = crate::plugins::get(cx) {
                            plugins.update(cx, |plugins, cx| plugins.remove(&remove_uid, cx));
                        }
                    })),
            )
            .when(showing_log, |el| {
                el.child(
                    div()
                        .id(SharedString::from(format!("plugin-log-lines-{uid}")))
                        .max_h(px(220.))
                        .overflow_y_scroll()
                        .p(px(10.))
                        .rounded(RADIUS_S)
                        .bg(theme.bg0)
                        .font_family(theme::FONT_MONO)
                        .text_size(px(11.5))
                        .children(if item.log.is_empty() {
                            vec![div().text_color(theme.text3).child("Nothing yet.").into_any_element()]
                        } else {
                            item.log
                                .iter()
                                .map(|line| div().text_color(match line.level.as_str() {
                                    "error" => theme.red,
                                    "warn" => theme.amber,
                                    _ => theme.text2,
                                }).child(line.text.clone()).into_any_element())
                                .collect()
                        }),
                )
            })
            .into_any_element()
    }

    fn marketplace(&mut self, cx: &mut Context<Self>) -> Vec<AnyElement> {
        let theme = theme(cx);
        let Some(plugins) = crate::plugins::get(cx) else { return Vec::new() };
        let (index, loading, error, installing, installed) = {
            let plugins = plugins.read(cx);
            let installed: HashMap<String, String> = plugins.record.plugins.iter().filter(|plugin| plugin.origin == Origin::Verified).map(|plugin| (plugin.id.clone(), plugin.version.clone())).collect();
            (plugins.market.index.clone(), plugins.market.loading, plugins.market.error.clone(), plugins.market.installing.clone(), installed)
        };
        let mut parts = Vec::new();
        parts.push(field(None, self.plugin_search.clone(), None, None, false, None, cx).into_any_element());
        if loading && index.is_none() {
            parts.push(div().flex().items_center().gap(px(8.)).text_color(theme.text2).child(spinner(14., theme.text2)).child("Reading the marketplace…").into_any_element());
        }
        if let Some(error) = error {
            parts.push(notice("triangle-alert", error, cx).into_any_element());
        }
        let Some(index) = index else { return parts };
        let query = self.plugin_search.read(cx).text().trim().to_lowercase();
        let mut shown = 0;
        for entry in &index.plugins {
            if !query.is_empty() && !entry.name.to_lowercase().contains(&query) && !entry.summary.to_lowercase().contains(&query) {
                continue;
            }
            let Some((_, version)) = index.newest(&entry.id) else { continue };
            shown += 1;
            let permissions: Vec<String> = version.permissions.iter().filter_map(|name| crate::plugins::manifest::Permission::parse(name)).map(|permission| if permission == crate::plugins::manifest::Permission::Network { format!("Contacts {}", version.hosts.join(", ")) } else { permission.told().to_string() }).collect();
            let have = installed.get(&entry.id).cloned();
            let newer = have.as_ref().is_some_and(|have| crate::plugins::manifest::parse_version(&version.version) > crate::plugins::manifest::parse_version(have));
            let busy = installing.as_deref() == Some(entry.id.as_str());
            let id = entry.id.clone();
            let source = entry.source.clone();
            let action = if busy {
                button(SharedString::from(format!("market-{id}")), ButtonKind::Default, ButtonSize::Small, true, cx).child("Installing…")
            } else if have.is_some() && !newer {
                button(SharedString::from(format!("market-{id}")), ButtonKind::Default, ButtonSize::Small, true, cx).child("Installed")
            } else {
                button(SharedString::from(format!("market-{id}")), ButtonKind::Primary, ButtonSize::Small, false, cx).child(if newer { "Update" } else { "Install" }).on_click(move |_, _, cx| {
                    if let Some(plugins) = crate::plugins::get(cx) {
                        let result = plugins.update(cx, |plugins, cx| plugins.propose_market(&id, cx));
                        if let Err(error) = result {
                            crate::state::store(cx).update(cx, |state, cx| state.toast(error, ToastKind::Error, cx));
                        }
                    }
                })
            };
            parts.push(
                div()
                    .flex()
                    .flex_col()
                    .gap(px(6.))
                    .p(px(14.))
                    .rounded(RADIUS_M)
                    .bg(theme.bg1)
                    .border_1()
                    .border_color(theme.line)
                    .child(
                        div()
                            .flex()
                            .items_center()
                            .gap(px(10.))
                            .child(icon("puzzle", 18., theme.text2))
                            .child(div().flex_1().min_w_0().flex().flex_col().child(div().font_weight(FontWeight::MEDIUM).child(entry.name.clone())).child(div().text_size(px(12.)).text_color(theme.text3).child(format!("{} · by {} · {}", version.version, entry.author, entry.license))))
                            .child(action),
                    )
                    .child(div().text_size(px(13.)).child(entry.summary.clone()))
                    .child(div().text_size(px(12.)).text_color(theme.text2).child(if permissions.is_empty() { "Asks for nothing of your account.".to_string() } else { permissions.join(" · ") }))
                    .when(!source.is_empty(), |el| el.child(div().id(SharedString::from(format!("market-source-{}", entry.id))).text_size(px(12.)).text_color(theme.link).cursor_pointer().child("Source").on_click(move |_, _, cx| cx.open_url(&source))))
                    .into_any_element(),
            );
        }
        if shown == 0 {
            parts.push(div().text_size(px(13.)).text_color(theme.text2).child(if query.is_empty() { "Nothing is on the marketplace yet." } else { "No plugin matches." }).into_any_element());
        }
        parts
    }

    /// A plugin's own section: its view for its settings, or the settings its manifest names.
    pub(super) fn plugin_section(&mut self, uid: &str, cx: &mut Context<Self>) -> Vec<AnyElement> {
        let theme = theme(cx);
        let Some(plugins) = crate::plugins::get(cx) else { return Vec::new() };
        let (name, verified, specs, values, has_view) = {
            let plugins = plugins.read(cx);
            let Some(loaded) = plugins.loaded.get(uid) else { return vec![Self::heading("Plugin", &theme)] };
            (loaded.manifest().name.clone(), loaded.record.verified(), loaded.manifest().contributes.settings.clone(), plugins.settings_of(uid), plugins.slots.get(uid).is_some_and(|slots| slots.settings_view))
        };
        let mut parts = vec![div().flex().items_center().gap(px(8.)).child(Self::heading(&name, &theme)).when(!verified, |el| el.child(crate::ui::plugins::unverified_mark(cx))).into_any_element()];
        if has_view {
            if crate::plugins::security_question_up(cx) {
                return parts;
            }
            let node = plugins.read(cx).view(uid, "settings:settings").cloned();
            parts.push(match node {
                Some(node) => crate::ui::plugins::view::render(uid, &node, cx),
                None => div().text_color(theme.text3).child("Starting…").into_any_element(),
            });
            return parts;
        }
        for spec in specs {
            let key = spec.key().to_string();
            let value = values.get(&key).cloned().unwrap_or_else(|| spec.default_value());
            let control: AnyElement = match &spec {
                crate::plugins::manifest::SettingSpec::Switch { .. } => {
                    let on = value.as_bool().unwrap_or(false);
                    let (uid, key) = (uid.to_string(), key.clone());
                    switch(SharedString::from(format!("plugin-setting-{uid}-{key}")), on, cx)
                        .on_click(move |_, _, cx| {
                            if let Some(plugins) = crate::plugins::get(cx) {
                                plugins.update(cx, |plugins, cx| plugins.set_setting(&uid, &key, json!(!on), cx));
                            }
                        })
                        .into_any_element()
                }
                crate::plugins::manifest::SettingSpec::Select { choices, .. } => {
                    let current = value.as_str().unwrap_or_default().to_string();
                    let options = choices
                        .iter()
                        .map(|choice| {
                            let (uid, key, label) = (uid.to_string(), key.clone(), choice.clone());
                            let choice = choice.clone();
                            let action: std::rc::Rc<dyn Fn(&mut Window, &mut gpui::App)> = std::rc::Rc::new(move |_, cx| {
                                if let Some(plugins) = crate::plugins::get(cx) {
                                    let choice = choice.clone();
                                    plugins.update(cx, |plugins, cx| plugins.set_setting(&uid, &key, json!(choice), cx));
                                }
                            });
                            (label, action)
                        })
                        .collect();
                    div().w(px(200.)).child(select_box(SharedString::from(format!("plugin-setting-{uid}-{key}")), current, options, cx)).into_any_element()
                }
                crate::plugins::manifest::SettingSpec::Slider { .. } => {
                    let (uid, key) = (uid.to_string(), key.clone());
                    div()
                        .w(px(200.))
                        .child(slider(SharedString::from(format!("plugin-setting-{uid}-{key}")), value.as_f64().unwrap_or(0.5) as f32, move |level, _, cx| {
                            if let Some(plugins) = crate::plugins::get(cx) {
                                plugins.update(cx, |plugins, cx| plugins.set_setting(&uid, &key, json!(level), cx));
                            }
                        }, cx))
                        .into_any_element()
                }
                crate::plugins::manifest::SettingSpec::Text { placeholder, .. } => {
                    let field_key = format!("{uid}|{key}");
                    let input = FIELDS.with(|fields| fields.borrow().get(&field_key).map(|(input, _)| input.clone()));
                    let input = input.unwrap_or_else(|| {
                        let placeholder = placeholder.clone().unwrap_or_default();
                        let text = value.as_str().unwrap_or_default().to_string();
                        let input = cx.new(|cx| {
                            let mut input = TextInput::new(cx, placeholder);
                            input.set_text(text, cx);
                            input
                        });
                        let (owner, setting) = (uid.to_string(), key.clone());
                        // Held by the app, not this view, so the field still saves once Settings opens again.
                        let app: &mut gpui::App = &mut **cx;
                        let subscription = app.subscribe(&input, move |input, event: &InputEvent, cx| {
                            if matches!(event, InputEvent::Changed) {
                                let text = input.read(cx).text().to_string();
                                if let Some(plugins) = crate::plugins::get(cx) {
                                    plugins.update(cx, |plugins, cx| plugins.set_setting(&owner, &setting, json!(text), cx));
                                }
                            }
                        });
                        FIELDS.with(|fields| fields.borrow_mut().insert(field_key, (input.clone(), subscription)));
                        input
                    });
                    div().w(px(220.)).child(field(None, input, None, None, false, None, cx)).into_any_element()
                }
            };
            parts.push(Self::row(spec.label(), spec.hint(), control, &theme));
        }
        parts
    }

    /// Asked once, as the switch for unverified plugins goes on: what it opens up.
    pub(super) fn unverified_confirm(&self, cx: &mut Context<Self>) -> AnyElement {
        let view = cx.entity().downgrade();
        let cancel_view = view.clone();
        crate::ui::overlays::confirm(
            "Allow plugins Zuna hasn't checked?".into(),
            "Allow them",
            "Nobody on Zuna's team has read such a plugin's code, and nothing confirms who wrote it. One allowed to read your messages and reach the internet can send them anywhere. If someone told you to turn this on to fix a problem, to win something, or to see something hidden, it's a scam.".into(),
            move |_, cx| {
                cancel_view.update(cx, |view, cx| {
                    view.confirming_unverified = false;
                    cx.notify();
                })
                .ok();
            },
            move |_, cx| {
                if let Some(plugins) = crate::plugins::get(cx) {
                    plugins.update(cx, |plugins, cx| plugins.set_allow_unverified(true, cx));
                }
                view.update(cx, |view, cx| {
                    view.confirming_unverified = false;
                    cx.notify();
                })
                .ok();
            },
            cx,
        )
    }
}
