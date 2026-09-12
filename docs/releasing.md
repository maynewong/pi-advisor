# Publishing to npm

## Packages and versions

| Workspace | npm package | Initial version |
| --- | --- | --- |
| `packages/core` | `@maynewong/pi-advisor-core` | `0.1.0` |
| `packages/ux` | `@maynewong/pi-advisor` | `0.1.0` |

The workspace root stays private and is not published. Both packages use public access. The plugin depends on the exact matching core version, so publish core first. The unscoped `pi-advisor` name belongs to another project.

## Before the first release

- Confirm your npm account can publish under the `@maynewong` scope.
- The project uses **MIT**. The root and both packages must contain identical `LICENSE` files and declare `"license": "MIT"`. Package tests verify this.
- Run `npm login` and `npm whoami` in your terminal and complete any required authentication or 2FA. Never store tokens or one-time codes in the repository.
- Check `npm view @maynewong/pi-advisor-core versions` and `npm view @maynewong/pi-advisor versions`. An `E404` is expected before the first release, but does not establish publishing permissions. Published versions cannot be overwritten.

## Verify

From the repository root:

```bash
npm ci --ignore-scripts
npm run release:check
```

`release:check` runs unit tests, type checks, and package smoke tests. The package tests:

1. Create actual tarballs with `npm pack`, verify versions, dependencies, licenses, and required files, and reject non-release files such as `.rsls` placeholders.
2. Install the tarballs and locally tested Pi peer versions into a temporary directory outside the repository, without workspace symlinks or development dependencies.
3. Use Pi's loader to verify extension discovery, commands, tools, built-in role cards, public exports, and Herdr provider registration.
4. Remove the temporary directory.

This downloads public npm dependencies but does not publish packages, call models, or launch Herdr or external agents. Loading and registration checks do not replace live model or Herdr testing. Packages ship TypeScript source for Pi's loader; no separate build step is required.

To check packaging alone:

```bash
npm run test:package
npm pack --workspaces --dry-run --ignore-scripts
```

Publishing permissions still require separate verification. Commit the release changes and ensure the working tree is clean before publishing.

## Publish 0.1.0

Run these commands sequentially from the repository root:

```bash
npm publish -w packages/core --access public
npm view @maynewong/pi-advisor-core@0.1.0 version
npm publish -w packages/ux --access public
npm view @maynewong/pi-advisor@0.1.0 version
```

Wait until core is readable from the registry before publishing the plugin. Do not publish both in parallel. If only core succeeds, fix the plugin issue and continue; do not attempt to overwrite core's `0.1.0`.

Verify the user installation:

```bash
pi install npm:@maynewong/pi-advisor@0.1.0
```

If you previously installed a Git or local version, locate it with `pi list` and remove that installation first to avoid loading the extension twice. Users do not need to install core separately.

After a successful release, tag the release commit:

```bash
git tag -a v0.1.0 -m "Pi Advisor 0.1.0"
git push origin main
git push origin v0.1.0
```

## Later releases

Keep both workspace versions in sync and update the plugin's exact core dependency. Run `npm install --ignore-scripts` to update the lockfile, then repeat verification and publishing. Never reuse an already published version number.
