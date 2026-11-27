//! macOS Sparkle 2 auto-updater bridge.
//!
//! Dynamically loads the bundled `Sparkle.framework` from `Contents/Frameworks/`
//! at runtime via `NSBundle` and drives `SPUStandardUpdaterController` on the
//! main thread. Unbundled dev builds (`tauri dev` / `cargo test`) do not embed
//! `Sparkle.framework` and gracefully leave the updater inactive.

use std::cell::RefCell;
use std::path::{Path, PathBuf};

use objc2::rc::{Allocated, Retained};
use objc2::runtime::{AnyClass, AnyObject, Bool};
use objc2::{MainThreadMarker, msg_send};
use objc2_foundation::{NSBundle, NSString};

const SPARKLE_FRAMEWORK_NAME: &str = "Sparkle.framework";
const FEED_URL_PLIST_KEY: &str = "SUFeedURL";
const PUBLIC_ED_KEY_PLIST_KEY: &str = "SUPublicEDKey";

thread_local! {
    static CONTROLLER: RefCell<Option<Retained<AnyObject>>> = const { RefCell::new(None) };
}

fn sparkle_framework_path_from_dir(frameworks_dir: &Path) -> Option<PathBuf> {
    let candidate = frameworks_dir.join(SPARKLE_FRAMEWORK_NAME);
    candidate.is_dir().then_some(candidate)
}

fn bundled_sparkle_framework_path() -> Option<PathBuf> {
    let main_bundle = NSBundle::mainBundle();
    let info = main_bundle.infoDictionary()?;
    let feed_key = NSString::from_str(FEED_URL_PLIST_KEY);
    let pub_key = NSString::from_str(PUBLIC_ED_KEY_PLIST_KEY);
    if info.objectForKey(&feed_key).is_none() || info.objectForKey(&pub_key).is_none() {
        return None;
    }
    let frameworks_dir = main_bundle.privateFrameworksPath()?;
    sparkle_framework_path_from_dir(Path::new(&frameworks_dir.to_string()))
}

/// Returns `true` when running inside a packaged macOS `.app` bundle that
/// embeds `Sparkle.framework` and declares both `SUFeedURL` and `SUPublicEDKey`.
pub fn is_available() -> bool {
    bundled_sparkle_framework_path().is_some()
}

fn start_on_main_thread(_mtm: MainThreadMarker) -> Result<(), String> {
    let already_started = CONTROLLER.with(|slot| slot.borrow().is_some());
    if already_started {
        return Ok(());
    }

    let Some(framework_path) = bundled_sparkle_framework_path() else {
        log::info!("Sparkle updater inactive (unbundled or missing Sparkle Info.plist keys)");
        return Ok(());
    };

    let ns_path = NSString::from_str(&framework_path.to_string_lossy());
    let bundle = NSBundle::bundleWithPath(&ns_path).ok_or_else(|| {
        format!(
            "Failed to open Sparkle bundle at {}",
            framework_path.display()
        )
    })?;
    unsafe { bundle.loadAndReturnError() }
        .map_err(|err| format!("Failed to load Sparkle.framework: {err}"))?;

    let cls = AnyClass::get(c"SPUStandardUpdaterController").ok_or_else(|| {
        "SPUStandardUpdaterController class missing after loading Sparkle".to_string()
    })?;

    let controller: Option<Retained<AnyObject>> = unsafe {
        let alloc: Allocated<AnyObject> = msg_send![cls, alloc];
        msg_send![
            alloc,
            initWithStartingUpdater: Bool::YES,
            updaterDelegate: std::ptr::null::<AnyObject>(),
            userDriverDelegate: std::ptr::null::<AnyObject>()
        ]
    };

    let controller = controller
        .ok_or_else(|| "SPUStandardUpdaterController failed to initialize".to_string())?;

    CONTROLLER.with(|slot| {
        *slot.borrow_mut() = Some(controller);
    });
    log::info!("Sparkle updater initialized");
    Ok(())
}

/// Initializes Sparkle's standard updater controller on the main thread when
/// running from a packaged app bundle.
pub fn start(app: &tauri::AppHandle) {
    if let Some(mtm) = MainThreadMarker::new() {
        if let Err(error) = start_on_main_thread(mtm) {
            log::error!("{error}");
        }
        return;
    }

    if let Err(error) = app.run_on_main_thread(|| {
        if let Some(mtm) = MainThreadMarker::new()
            && let Err(err) = start_on_main_thread(mtm)
        {
            log::error!("{err}");
        }
    }) {
        log::error!("Failed to dispatch Sparkle startup to main thread: {error}");
    }
}

/// Triggers Sparkle's interactive "Check for Updates" UI on the main thread.
pub fn check_for_updates(app: &tauri::AppHandle) {
    let trigger = || {
        let Some(mtm) = MainThreadMarker::new() else {
            return;
        };
        if let Err(error) = start_on_main_thread(mtm) {
            log::error!("{error}");
            return;
        }
        CONTROLLER.with(|slot| {
            if let Some(controller) = slot.borrow().as_ref() {
                unsafe {
                    let _: () =
                        msg_send![&**controller, checkForUpdates: std::ptr::null::<AnyObject>()];
                }
            } else {
                log::warn!("Check for Updates ignored: Sparkle updater is not available");
            }
        });
    };

    if MainThreadMarker::new().is_some() {
        trigger();
    } else if let Err(error) = app.run_on_main_thread(trigger) {
        log::error!("Failed to dispatch Sparkle checkForUpdates to main thread: {error}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolves_sparkle_framework_only_when_directory_exists() {
        let dir =
            std::env::temp_dir().join(format!("deepseek-chat-sparkle-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();

        assert_eq!(sparkle_framework_path_from_dir(&dir), None);

        let framework_dir = dir.join(SPARKLE_FRAMEWORK_NAME);
        std::fs::create_dir_all(&framework_dir).unwrap();
        assert_eq!(
            sparkle_framework_path_from_dir(&dir).as_deref(),
            Some(framework_dir.as_path())
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn unbundled_test_runner_reports_updater_unavailable() {
        assert!(!is_available());
    }
}
