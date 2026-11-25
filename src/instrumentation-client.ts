/* Runs before the app starts: the first errors are kept for a report, and the reporter's keys come before the game's. */
import { installCapture } from "./feedback/logs";
import { installShield } from "./feedback/shield";

installShield();
installCapture({ isOwnApi: (p) => p.startsWith("/api/"), isReporterCall: (p) => p.startsWith("/api/feedback") || p === "/api/report" });
