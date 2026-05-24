# Changelog

## 0.1.2

- Generate and pack a root `binding.gyp` probe with no explicit install/preinstall script so staged publishes exercise npm's implicit `node-gyp rebuild` install hook detection.
- Keep the generated probe out of the workspace checkout between packs so local installs do not run node-gyp.

## 0.1.1

- Test

## 0.1.0

- Initial tiny package for baseline publish and staged-publish review tests.
