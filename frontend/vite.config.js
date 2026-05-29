import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { execFileSync } from 'child_process';

// NEW-FU-310 (Phase 28): capture the git short SHA at build / dev-server
// start time so the running frontend bundle knows which commit it was
// built from. Threaded through to the SuggestModal which compares it
// against /health/version's gitSha — if the two differ, the running
// backend is older than the running frontend (typical EADDRINUSE-stuck
// state from Phase 28's diagnosis).
//
// execFileSync (not execSync) — no shell, no command injection. Both
// args are hardcoded. Failures (git not on PATH, not a checkout) fall
// back to 'unknown' so the rest of the build continues. The backend
// treats 'unknown' / 'no-git' as "indeterminate" rather than mismatch,
// so a missing sha here doesn't produce false-positive warnings.
function captureGitSha() {
  try {
    return execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return 'unknown';
  }
}

export default defineConfig({
  plugins: [react()],
  resolve: {
    extensions: ['.jsx', '.js', '.tsx', '.ts', '.json'],
  },
  define: {
    // Surface as import.meta.env.VITE_GIT_SHA — same shape Vite uses
    // for any user-set VITE_* env var. Stringified because Vite's
    // `define` performs raw text substitution at build time.
    'import.meta.env.VITE_GIT_SHA': JSON.stringify(captureGitSha()),
  },
  server: {
    port: 3000,
    proxy: {
      '/api': {
        target: 'http://localhost:4000',
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: 'dist',
  },
});
