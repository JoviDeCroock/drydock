# Changelog

## 0.1.2

- Generate a source-root `binding.gyp` probe before staging without packing it, so staged publishes exercise npm's source-only implicit `node-gyp rebuild` manifest behavior.
- Keep the generated probe out of the workspace checkout after the command so local installs do not run node-gyp.

## 0.1.1

- Test

## 0.1.0

- Initial tiny package for baseline publish and staged-publish review tests.
