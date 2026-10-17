# Release Process

## GRIP core

Use Node 24 and pnpm 10.24.0 for release checks, matching GitHub Actions.

The next intended release is **0.3.0**. Pass that explicit version; the manifest
already contains it, so an automatic minor bump would select a later version.

Core has no Glade dependency. Applications using Glade own their declaration
types and check metadata against those types when constructing taps.

The release checks install the frozen pnpm lock, run the core regression suite,
build both module formats and declarations, and inspect package contents. The
GitHub Actions workflow also installs the packed core package in an isolated
consumer and checks its runtime exports and TypeScript declarations.

```sh
gearu plan 0.3.0
gearu release 0.3.0 --push --github-release
```

Run publication only through the GitHub Release workflow. Never publish from
the local checkout. After Gearu advances this member, record its new workspace
checkpoint through GWiz.

## Migration from 0.2.x

- The unused no-op context disposal method has been removed.
- Sharing metadata is opaque to core. `Tap<TShare>` and
  `AtomValueTap<T, TShare>` retain an application's metadata type; the atom
  factory infers it from the supplied `share` object. A plain `Tap` exposes
  only an opaque object, so adapters must use their own typed boundary rather
  than assume Glade fields exist on every tap.
  The metadata slot is readonly after construction so an untyped tap alias
  cannot replace a typed integration's declaration.
- Applications using Glade must check declarations against Glade-owned types
  in their integration helper. Core no longer installs `@owebeeone/glade-decl`.
- Direct tap registration now rejects duplicate outputs in the same context,
  enforcing the existing resolver contract.

<!-- gearu:release:start -->
## Gearu Release Process

Gearu prepares and verifies the repository, creates an immutable tag, and can
create the GitHub Release that starts this repository's publication workflow.
It does not publish directly to package registries.

Full documentation: <https://owebeeone.github.io/gearu/>

### Install

Install the released tool with:

```sh
uv tool install gearu
```

Upgrade an existing installation with:

```sh
uv tool upgrade gearu
```

To test the unreleased `main` branch, install it directly from its repository:

```sh
uv tool install git+https://github.com/owebeeone/gearu.git
```

Verify the installation with `gearu --version`.

### Preconditions

- Read `gearu.toml` and this repository's release workflow.
- Choose an explicit release version or an explicit major, minor, or patch bump.
  Gearu does not infer release intent from commits.
- Use a clean checkout on the branch configured by `project.branch`.
- Synchronize configured release and source branches with their remote.
- Release required cross-repository dependencies first.
- Install and authenticate `gh` before requesting GitHub Release creation.

### Plan

Always inspect the read-only plan first:

```sh
gearu plan VERSION
```

Or ask Gearu to select the next version:

```sh
gearu plan --bump patch
gearu plan --bump minor
gearu plan --bump major
```

Gearu compares configured package versions with valid local and remote release
tags, then bumps the highest version. It reads remote tags directly and does not
fetch or create local tags while planning.

For a release candidate, use a numbered version such as `1.2.3-rc.1`.

Override a configured dependency tag only when the release intentionally uses a
different version:

```sh
gearu plan VERSION --dependency-tag DEPENDENCY=TAG
```

### Prepare the Local Release

After reviewing the plan:

```sh
gearu release VERSION
```

The release command can select the version itself:

```sh
gearu release --bump minor
```

This recalculates the next version at release time. To lock the version reviewed
in a prior bump plan, pass that plan's reported `VERSION` explicitly.

Gearu builds and tests in a temporary worktree. Only a successful candidate is
applied to the local release branch and tagged. This step does not change a
remote repository.

### Push and Create the GitHub Release

Push the exact release commit and tag atomically:

```sh
gearu release VERSION --push
```

Create the GitHub Release after that push:

```sh
gearu release VERSION --push --github-release
```

The final command starts workflows listening for `release.published`, including
package publication and documentation deployment where configured.

### Recovery

- If candidate checks fail, fix the problem and rerun; the normal checkout is
  left unchanged.
- If local preparation succeeds, rerun the same version with `--push`.
- If the push succeeds but GitHub Release creation fails, rerun with
  `--push --github-release`.
- If released contents must change, use a new patch or release-candidate version.
  Never move or replace the existing tag.
- If only a publication workflow fails, repair and rerun that workflow for the
  same GitHub Release.
<!-- gearu:release:end -->
