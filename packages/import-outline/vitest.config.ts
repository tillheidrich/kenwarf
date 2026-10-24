import { defineConfig } from 'vitest/config';

// git-Commits und scrypt brauchen Zeit; mehrere Läufe parallel machen es langsamer
export default defineConfig({ test: { testTimeout: 60_000, hookTimeout: 60_000 } });
