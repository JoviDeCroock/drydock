// @ts-nocheck
import { describe, expect, test } from "vitest";
import { parseGemspecMetadata } from "../server/lib/adapters/rubygems/gemspec.ts";

// A realistic Gem::Specification#to_yaml emission: native extension, executables,
// runtime + development dependencies, a metadata hash, and a Ruby version bound.
const FULL = `--- !ruby/object:Gem::Specification
name: example-gem
version: !ruby/object:Gem::Version
  version: 2.4.1
platform: ruby
authors:
- Jane Doe
autorequire:
bindir: exe
cert_chain: []
date: 2026-01-02 00:00:00.000000000 Z
dependencies:
- !ruby/object:Gem::Dependency
  name: nokogiri
  requirement: !ruby/object:Gem::Requirement
    requirements:
    - - ">="
      - !ruby/object:Gem::Version
        version: '1.10'
  type: :runtime
  prerelease: false
  version_requirements: !ruby/object:Gem::Requirement
    requirements:
    - - ">="
      - !ruby/object:Gem::Version
        version: '1.10'
- !ruby/object:Gem::Dependency
  name: rspec
  requirement: !ruby/object:Gem::Requirement
    requirements:
    - - "~>"
      - !ruby/object:Gem::Version
        version: '3.0'
  type: :development
  prerelease: false
  version_requirements: !ruby/object:Gem::Requirement
    requirements:
    - - "~>"
      - !ruby/object:Gem::Version
        version: '3.0'
description: An example gem.
email:
- jane@example.com
executables:
- example
extensions:
- ext/example/extconf.rb
extra_rdoc_files: []
files:
- exe/example
- ext/example/extconf.rb
- lib/example.rb
homepage: https://example.com/gem
licenses:
- MIT
metadata:
  allowed_push_host: https://rubygems.org
  source_code_uri: https://github.com/example/gem
post_install_message:
rdoc_options: []
require_paths:
- lib
required_ruby_version: !ruby/object:Gem::Requirement
  requirements:
  - - ">="
    - !ruby/object:Gem::Version
      version: 2.7.0
required_rubygems_version: !ruby/object:Gem::Requirement
  requirements:
  - - ">="
    - !ruby/object:Gem::Version
      version: '0'
requirements: []
rubygems_version: 3.5.3
signing_key:
specification_version: 4
summary: An example gem
test_files: []
`;

describe("parseGemspecMetadata", () => {
  test("extracts identity, capabilities, deps, and metadata", () => {
    const spec = parseGemspecMetadata(FULL);
    expect(spec.name).toBe("example-gem");
    expect(spec.version).toBe("2.4.1");
    expect(spec.platform).toBe("ruby");
    expect(spec.bindir).toBe("exe");
    expect(spec.homepage).toBe("https://example.com/gem");
    expect(spec.executables).toEqual(["example"]);
    expect(spec.extensions).toEqual(["ext/example/extconf.rb"]);
    expect(spec.requirePaths).toEqual(["lib"]);
    expect(spec.licenses).toEqual(["MIT"]);
    expect(spec.requiredRubyVersion).toBe(">= 2.7.0");
    expect(spec.dependencies).toEqual([
      { name: "nokogiri", type: "runtime" },
      { name: "rspec", type: "development" },
    ]);
    expect(spec.metadata.allowed_push_host).toBe("https://rubygems.org");
    expect(spec.metadata.source_code_uri).toBe("https://github.com/example/gem");
  });

  test("handles empty lists and a pure-ruby gem with no extensions", () => {
    const spec = parseGemspecMetadata(`--- !ruby/object:Gem::Specification
name: tiny
version: !ruby/object:Gem::Version
  version: 0.1.0
platform: ruby
dependencies: []
executables: []
extensions: []
require_paths:
- lib
licenses: []
metadata: {}
`);
    expect(spec.name).toBe("tiny");
    expect(spec.version).toBe("0.1.0");
    expect(spec.executables).toEqual([]);
    expect(spec.extensions).toEqual([]);
    expect(spec.dependencies).toEqual([]);
    expect(spec.metadata).toEqual({});
  });

  test("renders a compound ruby version requirement", () => {
    const spec = parseGemspecMetadata(`--- !ruby/object:Gem::Specification
name: ranged
version: !ruby/object:Gem::Version
  version: 1.0.0
required_ruby_version: !ruby/object:Gem::Requirement
  requirements:
  - - ">="
    - !ruby/object:Gem::Version
      version: '2.6'
  - - "<"
    - !ruby/object:Gem::Version
      version: '4.0'
`);
    expect(spec.requiredRubyVersion).toBe(">= 2.6, < 4.0");
  });

  test("degrades to empty summary on junk input", () => {
    expect(parseGemspecMetadata("not yaml at all").name).toBeNull();
    expect(parseGemspecMetadata(null).executables).toEqual([]);
    expect(parseGemspecMetadata("").dependencies).toEqual([]);
  });

  test("unquotes double-quoted scalars", () => {
    const spec = parseGemspecMetadata(`--- !ruby/object:Gem::Specification
name: "quoted-name"
version: !ruby/object:Gem::Version
  version: "1.2.3"
executables:
- "my exe"
`);
    expect(spec.name).toBe("quoted-name");
    expect(spec.version).toBe("1.2.3");
    expect(spec.executables).toEqual(["my exe"]);
  });
});
