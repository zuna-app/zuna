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
                // A plugin of themes alone runs no script, so it's on whenever it's loaded and switched on.
                running: plugins.running(&uid) || loaded.is_some_and(|loaded| !loaded.manifest().scripted() && record.enabled && plugins.safe_mode.is_none()),
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
            Ok(meta) if meta.len() > crate::plugins::package::MAX_PACKAGE as u64 => Err("A plugin package can be at most 8 MB.".to_string()),
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
            Self::lead("Plugins change how the app works on this device only, and no server knows about them. Each one runs separately from your keys and can only do what you've allowed.".into(), &theme),
        ];
        if let Some(reason) = safe_mode {
            parts.push(notice("info", reason, cx).into_any_element());
        }
        if !usable {
            parts.push(notice("triangle-alert", "Plugins can't be installed because this device's key couldn't be read.", cx).into_any_element());
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
            parts.push(div().text_size(px(13.)).text_color(theme.text2).child("None yet. No plugins come with the app, and a device without plugins never contacts the marketplace.").into_any_element());
        }
        for item in items {
            parts.push(self.installed_row(item, cx));
        }
        parts.push(Self::divider(&theme));
        parts.push(Self::subheading("Advanced"));
        parts.push(Self::row(
            "Allow plugins Zuna hasn't checked",
            Some("Plugins from a file or folder that nobody on Zuna's team has reviewed. They're marked wherever they appear."),
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
        parts.push(div().text_size(px(12.5)).text_color(theme.text3).child("You can also drop a plugin file here. Plugins can never be installed from a chat.").into_any_element());
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
                vec![div().text_size(px(12.5)).text_color(theme.text2).child("Doesn't need any access to your account.").into_any_element()]
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
            parts.push(div().flex().items_center().gap(px(8.)).text_color(theme.text2).child(spinner(14., theme.text2)).child("Loading the marketplace…").into_any_element());
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
                    .child(div().text_size(px(12.)).text_color(theme.text2).child(if permissions.is_empty() { "Doesn't need any access to your account.".to_string() } else { permissions.join(" · ") }))
                    .when(!source.is_empty(), |el| el.child(div().id(SharedString::from(format!("market-source-{}", entry.id))).text_size(px(12.)).text_color(theme.link).cursor_pointer().child("Source").on_click(move |_, _, cx| cx.open_url(&source))))
                    .into_any_element(),
            );
        }
        if shown == 0 {
            parts.push(div().text_size(px(13.)).text_color(theme.text2).child(if query.is_empty() { "Nothing is on the marketplace yet." } else { "No plugins match." }).into_any_element());
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
            "Nobody on Zuna's team has reviewed these plugins, and there's no way to confirm who wrote them. One that can read your messages and access the internet could send them anywhere. If someone told you to turn this on to fix a problem, to win something, or to see something hidden, it's a scam.".into(),
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

#[cfg(test)]
mod tests {
    //! Settings' Plugins page and a plugin's own section, clicked through: the switch for plugins
    //! Zuna hasn't checked, asked about as it goes on; a plugin turned off and on, its log, and
    //! removing it; installing from a file and a folder; the marketplace's listing as an index
    //! gives it, an update waiting for the person; and each kind of setting a plugin declares.

    use gpui::TestAppContext;
    use serde_json::json;

    use super::*;
    use crate::plugins::tests_running::{Harness, manifest, package, source};
    use crate::state::Overlay;

    fn settings(harness: &Harness, cx: &mut TestAppContext) -> Entity<SettingsView> {
        harness.app.window.update(cx, |root, _, _| root.settings.as_ref().and_then(|(_, view)| view.clone().downcast::<SettingsView>().ok())).unwrap().expect("Settings are open")
    }

    /// Opens a section of Settings, with nothing moving, so that what closed doesn't cover it while it goes.
    fn section(harness: &Harness, cx: &mut TestAppContext, section: &str) {
        harness.app.update(cx, |state, cx| {
            state.settings.reduce_motion = true;
            state.toasts.clear();
            state.set_overlay(Some(Overlay::Settings { section: Some(section.into()) }), cx);
        });
    }

    #[gpui::test]
    fn plugins_are_turned_on_and_off_installed_and_removed_from_settings(cx: &mut TestAppContext) {
        crate::ui::motion::set_reduced(true);
        let harness = Harness::open(cx, "settingsplug", &["messages.read", "network"], |m| m["hosts"] = json!(["api.example.com"]));
        let (app, uid) = (&harness.app, harness.uid.clone());
        harness.say(cx, json!({ "t": "log", "level": "error", "text": "Something broke" }));
        harness.say(cx, json!({ "t": "log", "level": "warn", "text": "Careful" }));
        section(&harness, cx, "plugins");
        // Its log, from its row.
        app.click(cx, &format!("plugin-log-{uid}"));
        let view = settings(&harness, cx);
        assert_eq!(cx.read(|cx| view.read(cx).showing_log.clone()), Some(uid.clone()));
        app.click(cx, &format!("plugin-log-{uid}"));
        assert_eq!(cx.read(|cx| view.read(cx).showing_log.clone()), None);
        // Off and on again.
        app.click(cx, &format!("plugin-on-{uid}"));
        assert!(!harness.read(cx, |plugins| plugins.loaded[&uid].record.enabled));
        app.click(cx, &format!("plugin-on-{uid}"));
        assert!(harness.read(cx, |plugins| plugins.loaded[&uid].record.enabled));
        // The switch for plugins Zuna hasn't checked: off at once, and on only once it's been explained.
        app.click(cx, "plugins-unverified");
        assert!(!harness.read(cx, |plugins| plugins.record.allow_unverified));
        assert!(!cx.read(|cx| view.read(cx).confirming_unverified), "turning it off asks nothing");
        app.click(cx, "plugins-unverified");
        assert!(cx.read(|cx| view.read(cx).confirming_unverified));
        app.click(cx, "confirm-cancel");
        assert!(!harness.read(cx, |plugins| plugins.record.allow_unverified));
        app.click(cx, "plugins-unverified");
        app.click(cx, "confirm-action");
        assert!(harness.read(cx, |plugins| plugins.record.allow_unverified));

        // From a file the person picks: asked about first, and a file that's too large is refused.
        let dir = crate::plugins::tests_running::fresh("settingsplug-files");
        let file = dir.join("other.zunaplugin");
        std::fs::write(&file, package(&manifest("otherplug", &[], |_| {}), b"globalThis.__zunaDefine(() => {});")).unwrap();
        app.click(cx, "plugins-file");
        cx.simulate_path_prompt_response(|_| Some(vec![file.clone()]));
        app.run(cx);
        assert!(matches!(app.read(cx, |state| state.overlay.clone()), Some(Overlay::PluginInstall { .. })));
        assert_eq!(harness.read(cx, |plugins| plugins.proposal.as_ref().map(|proposal| proposal.name.clone())), Some("Plugin otherplug".into()));
        section(&harness, cx, "plugins");
        let large = dir.join("large.zunaplugin");
        std::fs::write(&large, vec![0u8; crate::plugins::package::MAX_PACKAGE + 1]).unwrap();
        app.click(cx, "plugins-file");
        cx.simulate_path_prompt_response(|_| Some(vec![large.clone()]));
        app.run(cx);
        assert!(app.toasts(cx).contains(&"A plugin package can be at most 8 MB.".to_string()));
        // And a developer's folder.
        let folder = source("folderplug", &[], |_| {});
        app.click(cx, "plugins-folder");
        cx.simulate_path_prompt_response(|_| Some(vec![folder.clone()]));
        app.run(cx);
        assert!(harness.read(cx, |plugins| plugins.proposal.as_ref().is_some_and(|proposal| proposal.name == "Plugin folderplug")));
        section(&harness, cx, "plugins");

        // Removed from its row, with everything it kept.
        app.click(cx, &format!("plugin-remove-{uid}"));
        assert!(harness.read(cx, |plugins| !plugins.loaded.contains_key(&uid) && plugins.record.find(&uid).is_none()));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[gpui::test]
    fn the_marketplace_lists_what_its_index_says_and_an_update_waits(cx: &mut TestAppContext) {
        crate::ui::motion::set_reduced(true);
        let harness = Harness::open(cx, "marketplug", &[], |_| {});
        let index: crate::plugins::market::Index = serde_json::from_value(json!({
            "serial": 3,
            "plugins": [
                { "id": "translator", "name": "Translator", "summary": "Translates.", "author": "Someone", "source": "https://example.com/src", "versions": [{ "version": "1.0.0", "api": 1, "file": "t.zunaplugin", "size": 1, "sha256": "aa", "permissions": ["messages.read", "network"], "hosts": ["api.example.com"] }] },
                { "id": "future", "name": "Future", "versions": [{ "version": "1.0.0", "api": 9, "file": "f.zunaplugin", "size": 1, "sha256": "bb", "permissions": [] }] }
            ]
        }))
        .unwrap();
        harness.plugins.update(cx, |plugins, cx| {
            cx.notify();
            plugins.market.index = Some(index.clone());
            plugins.market.error = Some("The marketplace sent an older list than this device has already seen.".into());
        });
        section(&harness, cx, "plugins");
        let view = settings(&harness, cx);
        view.update(cx, |view, cx| {
            view.browsing = true;
            cx.notify();
        });
        harness.app.run(cx);
        assert!(harness.app.drawn(cx, "market-translator") && !harness.app.drawn(cx, "market-future"), "only what runs in this Zuna");
        let search = cx.read(|cx| view.read(cx).plugin_search.clone());
        search.update(cx, |input, cx| input.set_text("nothing like it", cx));
        harness.app.run(cx);
        assert!(!harness.app.drawn(cx, "market-translator"));
        search.update(cx, |input, cx| input.set_text("transl", cx));
        harness.app.run(cx);
        harness.app.click(cx, "market-translator");
        assert!(harness.read(cx, |plugins| plugins.proposal.as_ref().is_some_and(|proposal| proposal.verified && proposal.name == "Translator")));

        // An update that asks for more waits on the person's word, from the plugin's row.
        section(&harness, cx, "plugins");
        let uid = harness.uid.clone();
        harness.plugins.update(cx, |plugins, cx| {
            plugins.market.waiting.insert(uid.clone(), index.plugins[0].versions[0].clone());
            cx.notify();
        });
        harness.app.run(cx);
        harness.app.click(cx, &format!("plugin-update-{uid}"));
        assert!(harness.app.toasts(cx).contains(&"No version of it works with this version of Zuna.".to_string()), "a folder's plugin isn't the marketplace's to update");
    }

    #[gpui::test]
    fn a_plugins_own_section_holds_each_kind_of_setting(cx: &mut TestAppContext) {
        crate::ui::motion::set_reduced(true);
        let harness = Harness::open(cx, "sectionplug", &[], |m| {
            m["contributes"] = json!({ "settings": [
                { "type": "switch", "key": "loud", "label": "Loud", "hint": "Makes it loud" },
                { "type": "select", "key": "language", "label": "Language", "choices": ["en", "pl", "de"] },
                { "type": "text", "key": "name", "label": "Name", "placeholder": "Yours" },
                { "type": "slider", "key": "level", "label": "Level" }
            ] });
        });
        let (app, uid) = (&harness.app, harness.uid.clone());
        section(&harness, cx, &format!("plugin:{uid}"));
        harness.sent(cx);
        app.click(cx, &format!("plugin-setting-{uid}-loud"));
        app.click(cx, &format!("plugin-setting-{uid}-language"));
        app.click(cx, "menu-item-1");
        std::thread::sleep(std::time::Duration::from_millis(200));
        app.run(cx);
        let told: Vec<serde_json::Value> = harness.sent(cx).into_iter().filter(|message| message["name"] == "settings").map(|message| message["data"].clone()).collect();
        assert_eq!(told, vec![json!({ "key": "loud", "value": true }), json!({ "key": "language", "value": "pl" })]);
        assert_eq!(harness.read(cx, |plugins| plugins.settings_of(&uid).get("language").cloned()), Some(json!("pl")));
        // Its text, as it's typed.
        let input = FIELDS.with(|fields| fields.borrow().get(&format!("{uid}|name")).map(|(input, _)| input.clone())).expect("its text field");
        input.update(cx, |input, cx| input.set_text("Ann", cx));
        app.run(cx);
        assert_eq!(harness.read(cx, |plugins| plugins.settings_of(&uid).get("name").cloned()), Some(json!("Ann")));
        // It's listed among Settings' sections while it's on.
        assert!(cx.read(|cx| SettingsView::plugin_sections(cx)).iter().any(|(listed, _, _)| *listed == uid));
        harness.plugins.update(cx, |plugins, cx| plugins.set_enabled(&uid, false, cx));
        assert!(cx.read(|cx| SettingsView::plugin_sections(cx)).is_empty());
    }
}
