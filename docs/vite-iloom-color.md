# Using ILOOM_COLOR_HEX in a Vite App

When you run a dev server inside a loom shell (`il shell`), the `ILOOM_COLOR_HEX` environment variable is automatically set to the hex color assigned to that loom (e.g., `#dcebff`). This lets your app visually distinguish which loom it's running in.

## Setup

### 1. Prefix the variable for Vite

Vite only exposes env vars that start with `VITE_`. Add a `.env.local` (or use your existing one) in the project root:

```bash
# .env.local
VITE_ILOOM_COLOR_HEX=$ILOOM_COLOR_HEX
```

Or, if you use `il shell` and then start the dev server manually, you can set it inline:

```bash
VITE_ILOOM_COLOR_HEX=$ILOOM_COLOR_HEX pnpm dev
```

### 2. Access it in your app

```ts
// src/main.ts (or any client-side file)
const loomColor = import.meta.env.VITE_ILOOM_COLOR_HEX

if (loomColor) {
  document.documentElement.style.setProperty('--loom-color', loomColor)
}
```

### 3. Use the CSS variable

```css
/* src/styles.css */
:root {
  --loom-color: transparent; /* fallback when not in a loom */
}

body {
  border-top: 4px solid var(--loom-color);
}
```

## Alternative: Use `define` in vite.config.ts

If you don't want an extra `.env.local` entry, you can inject the value at build time:

```ts
// vite.config.ts
import { defineConfig } from 'vite'

export default defineConfig({
  define: {
    __ILOOM_COLOR_HEX__: JSON.stringify(process.env.ILOOM_COLOR_HEX ?? ''),
  },
})
```

Then in your app:

```ts
declare const __ILOOM_COLOR_HEX__: string

if (__ILOOM_COLOR_HEX__) {
  document.documentElement.style.setProperty('--loom-color', __ILOOM_COLOR_HEX__)
}
```

## React Example

```tsx
// src/components/LoomIndicator.tsx
function LoomIndicator() {
  const color = import.meta.env.VITE_ILOOM_COLOR_HEX
  if (!color) return null

  return (
    <div
      style={{
        position: 'fixed',
        top: 0,
        left: 0,
        right: 0,
        height: 4,
        backgroundColor: color,
        zIndex: 9999,
      }}
    />
  )
}
```

## How It Works

1. `il shell <issue>` reads the loom's metadata (stored in `~/.config/iloom-ai/looms/`) and exports `ILOOM_COLOR_HEX` into the shell environment.
2. Any process spawned from that shell inherits the variable.
3. Vite picks it up (via `VITE_` prefix or `define`) and makes it available to client code.

When you're not inside a loom shell, the variable is simply absent and your fallback styles apply.
