import '../compat';
import { runSync } from '../sync/index';

const port = process.env.PORT ? parseInt(process.env.PORT, 10) : 8085;

// The system tray is now started via the unified systemd service, so we no longer spawn it here.
runSync(port).catch(console.error);
