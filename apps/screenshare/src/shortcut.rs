//! Push to talk under Wayland, where only the compositor sees a key held in another
//! window. The global shortcuts portal binds the key, asking the person through the
//! compositor where it wants to, and says when it goes down and when it comes up. KDE,
//! GNOME and Hyprland have it, and a compositor that doesn't has no portal for it at all.

use std::io::BufRead;

use ashpd::desktop::global_shortcuts::{GlobalShortcuts, NewShortcut};
use futures_util::StreamExt;

use crate::encoder::Result;

const ID: &str = "push-to-talk";

/// Says which version of the portal there is, or 0 for none, and whether it lets this app
/// have a shortcut. It only does for an app it can name, which takes a .desktop file
/// installed under the name of the systemd scope the app runs in.
pub fn check(runtime: &tokio::runtime::Runtime) -> Result<()> {
    let (version, allowed) = runtime.block_on(async {
        let Ok(portal) = GlobalShortcuts::new().await else { return (0, false) };
        // ashpd takes a portal it can't ask for its version as the first, so this asks itself.
        let version = portal.get_property::<u32>("version").await.unwrap_or(0);
        if version == 0 {
            return (0, false);
        }
        // A session shows nothing to the person, and is refused where the app can't be named.
        let allowed = match portal.create_session(Default::default()).await {
            Ok(session) => {
                let _ = session.close().await;
                true
            }
            Err(_) => false,
        };
        (version, allowed)
    });
    println!("{{\"type\":\"shortcuts\",\"version\":{version},\"allowed\":{allowed}}}");
    Ok(())
}

/// Binds the key, as the XDG shortcuts specification names it, or whatever the person
/// chooses where that's empty. Then says each time it goes down and up, until standard
/// input closes.
pub fn watch(runtime: &tokio::runtime::Runtime, trigger: &str) -> Result<()> {
    let failed = |doing: &'static str| move |error: ashpd::Error| format!("{doing}: {error}");
    let (portal, session) = runtime.block_on(async {
        let portal = GlobalShortcuts::new().await.map_err(failed("Reaching the global shortcuts portal"))?;
        let session = portal.create_session(Default::default()).await.map_err(failed("Starting a global shortcuts session"))?;
        let shortcut = NewShortcut::new(ID, "Push to talk").preferred_trigger((!trigger.is_empty()).then_some(trigger));
        let bound = portal
            .bind_shortcuts(&session, &[shortcut], None, Default::default())
            .await
            .and_then(|request| request.response())
            .map_err(failed("Binding the key"))?;
        let ours = bound.shortcuts().iter().find(|shortcut| shortcut.id() == ID).ok_or("The key wasn't bound")?;
        println!("{{\"type\":\"bound\",\"trigger\":{:?}}}", ours.trigger_description());
        Ok::<_, String>((portal, session))
    })?;

    let mut down = runtime.block_on(portal.receive_activated()).map_err(failed("Listening for the key"))?;
    let mut up = runtime.block_on(portal.receive_deactivated()).map_err(failed("Listening for the key"))?;
    runtime.spawn(async move {
        while let Some(event) = down.next().await {
            if event.shortcut_id() == ID {
                println!("{{\"type\":\"down\"}}");
            }
        }
    });
    runtime.spawn(async move {
        while let Some(event) = up.next().await {
            if event.shortcut_id() == ID {
                println!("{{\"type\":\"up\"}}");
            }
        }
    });

    // The app closing standard input, or going, is the end of it.
    for line in std::io::stdin().lock().lines() {
        if line.is_err() {
            break;
        }
    }
    let _ = runtime.block_on(session.close());
    Ok(())
}
