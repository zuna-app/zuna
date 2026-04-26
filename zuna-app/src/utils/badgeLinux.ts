import { execFile } from "child_process";

// Works only with valid .desktop
export async function setBadgeCountLinux(count: number) {
    if (process.platform !== "linux") {
        return null;
    }

    const launcherEntry = `{'count-visible': <${count > 0}>, 'count': <${count}>}`;
    const args = [
        "emit",
        "--session",
        "--object-path",
        "/com/canonical/unity/launcherentry/0",
        "--signal",
        "com.canonical.Unity.LauncherEntry.Update",
        "application://zuna-app.desktop",
        launcherEntry,
    ];

    execFile("gdbus", args, error => {
        if (error) {
            console.warn("Failed to set Linux badge count:", error);
        }
    });
}
