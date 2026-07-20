import { registerRootComponent } from 'expo';

import CrashCatcher from './src/components/CrashCatcher';

// Temporarily registering CrashCatcher (which requires and renders App
// internally, inside a try/catch) instead of App directly, so a crash -
// whether during App's own module load or later at runtime - shows a
// readable error screen instead of silently closing. See
// src/components/CrashCatcher.js for details; once the current crash is
// tracked down, this can go back to `registerRootComponent(App)`.
registerRootComponent(CrashCatcher);
