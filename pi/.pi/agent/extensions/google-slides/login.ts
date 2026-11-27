import { login } from "./client";

// Standalone entry point for devenv's short-lived OAuth-only container.
const port = Number(process.argv[2]);
if (!Number.isSafeInteger(port) || port < 1024 || port > 65535) {
  console.error("Expected a callback port between 1024 and 65535.");
  process.exitCode = 1;
} else {
  try {
    await login({ port, container: true, showLink: (url) => {
      console.log(`Open this URL in the browser on your host (valid for 5 minutes):\n\n${url}\n`);
    } });
    console.log("Google Slides connected. You can return to Pi.");
  } catch (err) {
    console.error(err instanceof Error ? err.message : "Google Slides login failed.");
    process.exitCode = 1;
  }
}
