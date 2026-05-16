// Minimal Electron entry point — opens a single window for testing the
// Remote Dev Launcher extension. No preload or IPC; the page is static.

const { app, BrowserWindow } = require("electron");
const path = require("node:path");

function createWindow() {
	const win = new BrowserWindow({
		width: 720,
		height: 480,
		title: "Deskport Example",
		backgroundColor: "#1e1e1e",
	});
	win.loadFile(path.join(__dirname, "index.html"));
}

app.whenReady().then(() => {
	createWindow();
	// macOS: re-create a window when the dock icon is clicked and none are open.
	app.on("activate", () => {
		if (BrowserWindow.getAllWindows().length === 0) createWindow();
	});
});

// Quit when all windows are closed, except on macOS.
app.on("window-all-closed", () => {
	if (process.platform !== "darwin") app.quit();
});
