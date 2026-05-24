# Changelog

## 0.1.2

- Add a root `binding.gyp` probe with no explicit install/preinstall script so staged publishes exercise npm's implicit `node-gyp rebuild` install hook detection.
- Keep the probe out of the package `files` allowlist to test prepared-manifest recovery from staged metadata.

## 0.1.1

- Test

## 0.1.0

- Initial tiny package for baseline publish and staged-publish review tests.
