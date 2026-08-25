---
name: preact-signals-eslint-plugin
description: Configure, extend, or debug @preact/eslint-plugin-signals rules for unsafe reads, truthiness, computed writes, async use, or component-local creation.
---

# Preact Signals ESLint Plugin

## Core Approach

Use lint rules for common static signal misuse that issue history shows humans and agents repeat. The plugin supports projects using `@preact/signals-core`, `@preact/signals`, `@preact/signals-react`, and `@preact/signals-react/runtime`.

Treat each `.value` read as an intentional unboxing/subscription decision. The plugin catches many incorrect unboxing sites, such as reads after `await`, hidden reads behind non-reactive guards, writes from computed callbacks, and signal objects used as always-truthy booleans. It does not prove that a `.value` read is as granular as it could be; code review still needs to catch parent/provider unboxing that should have been deferred to a leaf component or DOM binding.

## Configuration

Oxlint:

```jsonc
{
  "jsPlugins": ["@preact/eslint-plugin-signals"],
  "rules": {
    "@preact/signals/no-signal-write-in-computed": "error",
    "@preact/signals/no-value-after-await": "error",
    "@preact/signals/no-signal-truthiness": "warn",
    "@preact/signals/no-signal-in-component-body": "error",
    "@preact/signals/no-conditional-value-read": "error"
  }
}
```

ESLint flat config:

```js
import signals from "@preact/eslint-plugin-signals";
import tsParser from "@typescript-eslint/parser";

export default [
  {
    plugins: { signals },
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      parser: tsParser,
      parserOptions: {
        ecmaFeatures: { jsx: true },
        project: true,
        tsconfigRootDir: import.meta.dirname
      }
    },
    rules: {
      "signals/no-signal-write-in-computed": "error",
      "signals/no-value-after-await": "error",
      "signals/no-signal-truthiness": "warn",
      "signals/no-signal-in-component-body": "error",
      "signals/no-conditional-value-read": "error"
    }
  }
];
```

## Rule Intent

| Rule | Catches |
| --- | --- |
| `no-signal-write-in-computed` | Side effects inside `computed()` or `useComputed()` |
| `no-value-after-await` | `.value` reads after `await` that are not tracked |
| `no-signal-truthiness` | `if (signal)` and similar always-truthy checks |
| `no-signal-in-component-body` | `signal()`, `computed()`, `effect()` created on every render |
| `no-conditional-value-read` | `.value` reads hidden behind non-reactive guards |

These rules protect correctness more than performance. They should be paired with the Preact integration skill's "unbox late" guidance for granularity.

## Common Limitations

- Cross-function data flow is not fully traced.
- Dynamic object aliases may not be detected without TypeScript type information.
- Oxlint currently has less type-aware information than ESLint with `@typescript-eslint/parser` and `project: true`.

## References

- Package docs: `node_modules/@preact/eslint-plugin-signals/README.md`
- Online: https://github.com/preactjs/signals/blob/main/packages/eslint-plugin-signals/README.md
