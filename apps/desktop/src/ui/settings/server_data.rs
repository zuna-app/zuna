//! Your data: everything the server says it keeps about the account, in the
//! core's plain words, and saved as the server's own answer (`ServerDataSection` in
//! packages/ui/src/features/overlays/Settings.tsx).

use super::*;
use crate::models::{ServerDataExport, ServerDataRow, ServerDataSection};

impl SettingsView {
    /// Asks the server for its export, once for each server while Settings is open, unless
    /// `again`.
    pub(super) fn load_server_data(&mut self, again: bool, cx: &mut Context<Self>) {
        let Some(server) = self.state.read(cx).active_server.clone() else { return };
        if self.loading_data || (!again && self.server_data.as_ref().is_some_and(|(id, _)| *id == server)) {
            return;
        }
        self.loading_data = true;
        let call = self.state.read(cx).core.call(Some(&server), "exportServerData", vec![]);
        let state = self.state.clone();
        cx.spawn(async move |view, cx| {
            let result = call.await;
            view.update(cx, |view, cx| {
                view.loading_data = false;
                match result {
                    Ok(value) => view.server_data = Some((server, from_value(value))),
                    Err(error) => state.update(cx, |state, cx| state.toast(error.message, ToastKind::Error, cx)),
                }
                cx.notify();
            })
            .ok();
        })
        .detach();
        cx.notify();
    }

    pub(super) fn server_data_page(&mut self, cx: &mut Context<Self>) -> Vec<AnyElement> {
        let theme = theme(cx);
        let Some((server, _)) = self.me(cx) else { return Vec::new() };
        let data: Option<ServerDataExport> = self.server_data.as_ref().filter(|(id, _)| *id == server.entry.id).map(|(_, data)| data.clone());
        let mut parts = vec![
            Self::heading("Your data", &theme),
            Self::lead(
                format!(
                    "Everything {} says it keeps about your account. Your messages, name, picture and files are encrypted on your devices before they're sent, so only their sizes appear here.",
                    server.entry.name
                ),
                &theme,
            ),
        ];
        let state = self.state.clone();
        let save = data.as_ref().map(|data| {
            let (file_name, json) = (data.file_name.clone(), data.json.clone());
            button("save-server-data", ButtonKind::Primary, ButtonSize::Normal, false, cx).child(icon("download", 15., theme.on_accent)).child("Save as file").on_click(move |_, _, cx| {
                let downloads = dirs::download_dir().unwrap_or_else(std::env::temp_dir);
                let chosen = cx.prompt_for_new_path(&downloads, Some(&file_name));
                let json = json.clone();
                state.update(cx, |_, cx| {
                    cx.spawn(async move |state, cx| {
                        let Ok(Ok(Some(path))) = chosen.await else { return };
                        let written = std::fs::write(&path, json);
                        state
                            .update(cx, |state, cx| match written {
                                Ok(()) => state.toast("Saved", ToastKind::Info, cx),
                                Err(error) => state.toast(format!("Couldn't save the file: {error}"), ToastKind::Error, cx),
                            })
                            .ok();
                    })
                    .detach();
                });
            })
        });
        let busy = self.loading_data;
        parts.push(
            div()
                .flex()
                .items_center()
                .gap(px(8.))
                .children(save)
                .child(
                    button("load-server-data", ButtonKind::Default, ButtonSize::Normal, busy, cx)
                        .when(busy, |el| el.child(spinner(14., theme.text2)))
                        .when(!busy, |el| el.child(icon("refresh-cw", 14., theme.text1)))
                        .child(if data.is_some() { "Ask again" } else { "Ask the server" })
                        .when(!busy, |el| el.on_click(cx.listener(|view, _, _, cx| view.load_server_data(true, cx)))),
                )
                .into_any_element(),
        );
        let Some(data) = data else { return parts };
        for section in &data.sections {
            parts.push(Self::data_section(section, &theme));
        }
        parts.push(
            div()
                .text_size(px(12.5))
                .text_color(theme.text3)
                .child(format!(
                    "This is what {} says it keeps. A modified server could keep more than it says, which is why everything that matters is encrypted on your devices before it's sent.",
                    server.entry.name
                ))
                .into_any_element(),
        );
        parts
    }

    fn data_section(section: &ServerDataSection, theme: &Theme) -> AnyElement {
        let rows = section.rows.iter().enumerate().map(|(index, row)| Self::data_row(row, index > 0, theme));
        div()
            .mt(px(6.))
            .flex()
            .flex_col()
            .gap(px(6.))
            .child(Self::subheading(&section.title))
            .child(div().text_size(px(13.)).text_color(theme.text2).child(section.about.clone()))
            .child(div().mt(px(2.)).flex().flex_col().rounded(RADIUS_M).border_1().border_color(theme.line).bg(theme.bg2).children(rows))
            .into_any_element()
    }

    fn data_row(row: &ServerDataRow, divided: bool, theme: &Theme) -> AnyElement {
        div()
            .flex()
            .items_start()
            .gap(px(14.))
            .px(px(12.))
            .py(px(9.))
            .when(divided, |el| el.border_t_1().border_color(theme.line))
            .child(
                div()
                    .flex_1()
                    .min_w_0()
                    .flex()
                    .flex_col()
                    .gap(px(2.))
                    .child(div().text_size(px(13.5)).font_weight(FontWeight::MEDIUM).child(row.label.clone()))
                    .when_some(row.note.clone(), |el, note| el.child(div().text_size(px(12.)).text_color(theme.text3).child(note))),
            )
            .child(
                div()
                    .flex_none()
                    .max_w(px(260.))
                    .flex()
                    .flex_col()
                    .items_end()
                    .gap(px(4.))
                    .child(div().text_right().text_size(px(13.)).text_color(theme.text1).child(row.value.clone()))
                    .child(Self::kind_tag(&row.kind, theme)),
            )
            .into_any_element()
    }

    /// What the server can do with a row, in a tag: amber for what it reads, green for what it
    /// can't.
    fn kind_tag(kind: &str, theme: &Theme) -> AnyElement {
        let soft = |color: gpui::Hsla| gpui::Hsla { a: 0.14, ..color };
        let (label, bg, fg) = match kind {
            "readable" => ("Readable", theme.amber_soft, theme.amber_text),
            "encrypted" => ("Encrypted", soft(theme.green), theme.green),
            "public" => ("Public", theme.bg4, theme.text2),
            "withheld" => ("Left out", theme.bg4, theme.text2),
            _ => ("Not kept", soft(theme.green), theme.green),
        };
        div().px(px(7.)).py(px(1.)).rounded(px(10.)).bg(bg).text_color(fg).text_size(px(11.)).font_weight(FontWeight::MEDIUM).child(label).into_any_element()
    }
}
