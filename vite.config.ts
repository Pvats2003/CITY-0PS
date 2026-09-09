import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { defineConfig } from 'vite'
import { VitePWA } from 'vite-plugin-pwa'
import path from 'path'
import { execSync } from 'node:child_process'

// Stamps the exact commit and timestamp this build was produced from into
// the bundle, so "is production actually running the commit I just
// pushed?" has a direct answer from the browser console instead of an
// assumption — see __CITY_OPS_BUILD_SHA__/__CITY_OPS_BUILD_TIME__ logged
// unmissably at app startup in src/main.tsx. Vercel builds from a real git
// checkout, so this reads the same SHA shown in its deployment dashboard;
// falls back to "unknown" if git isn't available (never fails the build
// over this). Full SHA, not the short one, so it can be pasted straight
// into a compare-commits URL without ambiguity.
const buildSha = (() => {
  try {
    return execSync('git rev-parse HEAD').toString().trim()
  } catch {
    return 'unknown'
  }
})()
const buildTime = new Date().toISOString()

// https://vite.dev/config/
export default defineConfig({
  define: {
    __CITY_OPS_BUILD_SHA__: JSON.stringify(buildSha),
    __CITY_OPS_BUILD_TIME__: JSON.stringify(buildTime),
  },
  plugins: [
    react(),
    tailwindcss(),
    // Installable, offline-capable app shell for Field Officers (spec
    // section 26). The manager dashboard shares the same build but isn't
    // required to be installed — it stays plain responsive web.
    VitePWA({
      registerType: 'autoUpdate',
      manifest: {
        name: 'City Ops OS — Field Officer',
        short_name: 'City Ops FO',
        description: 'Field Officer mobile app for City Ops OS.',
        start_url: '/fo',
        scope: '/',
        display: 'standalone',
        background_color: '#0b1220',
        theme_color: '#2663f2',
        icons: [
          { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
          { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
          { src: '/icons/icon-maskable-192.png', sizes: '192x192', type: 'image/png', purpose: 'maskable' },
          { src: '/icons/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        // Cache the app shell only — no Firestore/Firebase traffic is
        // intercepted, so a configured backend keeps its own network
        // behavior untouched by the service worker.
        navigateFallback: '/index.html',
        globPatterns: ['**/*.{js,css,html,svg,png,ico}'],
      },
    }),
  ],
  resolve: {
    alias: {
      '@': path.resolve(import.meta.dirname, './src'),
    },
  },
})
