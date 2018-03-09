/* @flow */

import type {Reporter} from '../../reporters/index.js';
import type {InstallCwdRequest} from './install.js';
import type {DependencyRequestPatterns, Manifest} from '../../types.js';
import type Config from '../../config.js';
import Lockfile from '../../lockfile';
import {normalizePattern} from '../../util/normalize-pattern.js';
import normalizeManifest from '../../util/normalize-manifest/index.js';
import WorkspaceLayout from '../../workspace-layout.js';
import {getExoticResolver} from '../../resolvers/index.js';
import {wrapLifecycle, Install} from './install.js';
import {registries} from '../../registries/index.js';
import {MessageError} from '../../errors.js';
import * as constants from '../../constants.js';
import * as fs from '../../util/fs.js';

import invariant from 'invariant';
import path from 'path';
import semver from 'semver';

export class Isolate extends Install {
  constructor(flags: Object, config: Config, reporter: Reporter, lockfile: Lockfile) {
    const workspaceRootIsCwd = config.cwd === config.lockfileFolder;
    const _flags = flags ? {...flags, workspaceRootIsCwd, isolated: true} : {workspaceRootIsCwd, isolated: true};
    super(_flags, config, reporter, lockfile);
  }

  siblingWorkspaces: Array<string>;

  async init(): Promise<Array<string>> {
    // running "yarn isolate" in a workspace root is not allowed
    if (this.config.workspaceRootFolder && this.config.cwd === this.config.workspaceRootFolder) {
      throw new MessageError(this.reporter.lang('workspacesIsolateRootCheck'));
    }

    await this.setSiblingWorkspaces();
    
    const patterns = await Install.prototype.init.call(this);
    return patterns;
  }

  async setSiblingWorkspaces(): Array<string>{
    let foundRegistry = false, rootLoc, workspaceLoc;
    for (const registry of Object.keys(registries)) {
      const {filename} = registries[registry];
      rootLoc = path.join(this.config.lockfileFolder, filename);
      workspaceLoc = path.join(this.config.cwd, filename);
      
      if (!await fs.exists(rootLoc) || !await fs.exists(workspaceLoc)) {
        continue;
      }

      foundRegistry = true;
      break;
    }
    if(!foundRegistry){
      //reporter
      console.warn('no sibling workspaces');
      return;
    }
    
    const rootManifest = await this.config.readJson(rootLoc);
    await normalizeManifest(rootManifest, this.config.lockfileFolder, this.config, true);
    const workspaceManifest = await this.config.readJson(workspaceLoc);
    await normalizeManifest(workspaceManifest, this.config.cwd, this.config, false);

    const currentWorkspace = workspaceManifest.name;
    const allWorkspaces = await this.config.resolveWorkspaces(this.config.lockfileFolder, rootManifest);
    this.siblingWorkspaces = Object.keys(allWorkspaces).filter(w => w !== currentWorkspace).map(w => {
      return `${w}@${allWorkspaces[w].manifest.version}`
    });
  }

  prepareRequests(requests: DependencyRequestPatterns): DependencyRequestPatterns {
    const requestsWithArgs = requests.slice();

    for (const workspace of this.siblingWorkspaces) {
      requestsWithArgs.push({
        pattern: workspace,
        registry: 'npm',
        optional: false,
      });
    }
    return requestsWithArgs;
  }

  /**
   * returns version for a pattern based on Manifest
   */
  getPatternVersion(pattern: string, pkg: Manifest): string {
    const tilde = this.flags.tilde;
    const configPrefix = String(this.config.getOption('save-prefix'));
    const exact = this.flags.exact || Boolean(this.config.getOption('save-exact')) || configPrefix === '';
    const {hasVersion, range} = normalizePattern(pattern);
    let version;

    if (getExoticResolver(pattern)) {
      // wasn't a name/range tuple so this is just a raw exotic pattern
      version = pattern;
    } else if (hasVersion && range && (semver.satisfies(pkg.version, range) || getExoticResolver(range))) {
      // if the user specified a range then use it verbatim
      version = range;
    }

    if (!version || semver.valid(version)) {
      let prefix = configPrefix || '^';

      if (tilde) {
        prefix = '~';
      } else if (version || exact) {
        prefix = '';
      }
      version = `${prefix}${pkg.version}`;
    }

    return version;
  }

  preparePatterns(patterns: Array<string>): Array<string> {
    const preparedPatterns = patterns.slice();
    for (const pattern of this.siblingWorkspaces) {
      const pkg = this.resolver.getResolvedPattern(pattern);
      const version = this.getPatternVersion(pattern, pkg);
      const newPattern = `${pkg.name}@${version}`;
      preparedPatterns.push(newPattern);
      if (newPattern === pattern) {
        continue;
      }
      this.resolver.replacePattern(pattern, newPattern);
    }
    return preparedPatterns;
  }

  preparePatternsForLinking(patterns: Array<string>, cwdManifest: Manifest, cwdIsRoot: boolean): Array<string> {
    // remove the newly added patterns if cwd != root and update the in-memory package dependency instead
    if (cwdIsRoot) {
      return patterns;
    }

    let manifest;
    const cwdPackage = `${cwdManifest.name}@${cwdManifest.version}`;
    try {
      manifest = this.resolver.getStrictResolvedPattern(cwdPackage);
    } catch (e) {
      this.reporter.warn(this.reporter.lang('unknownPackage', cwdPackage));
      return patterns;
    }

    let newPatterns = patterns;
    this._iterateAddedPackages((pattern, registry, dependencyType, pkgName, version) => {
      // remove added package from patterns list
      const filtered = newPatterns.filter(p => p !== pattern);
      invariant(
        newPatterns.length - filtered.length > 0,
        `expect added pattern '${pattern}' in the list: ${patterns.toString()}`,
      );
      newPatterns = filtered;

      // add new package into in-memory manifest so they can be linked properly
      manifest[dependencyType] = manifest[dependencyType] || {};
      if (manifest[dependencyType][pkgName] === version) {
        // package already existed
        return;
      }

      // update dependencies in the manifest
      invariant(manifest._reference, 'manifest._reference should not be null');
      const ref: Object = manifest._reference;

      ref['dependencies'] = ref['dependencies'] || [];
      ref['dependencies'].push(pattern);
    });

    return newPatterns;
  }

  async bailout(patterns: Array<string>, workspaceLayout: ?WorkspaceLayout): Promise<boolean> {
    // const lockfileCache = this.lockfile.cache;
    // if (!lockfileCache) {
    //   return false;
    // }
    // const match = await this.integrityChecker.check(patterns, lockfileCache, this.flags, workspaceLayout);
    // const haveLockfile = await fs.exists(path.join(this.config.lockfileFolder, constants.LOCKFILE_FILENAME));
    // if (match.integrityFileMissing && haveLockfile) {
    //   // Integrity file missing, force script installations
    //   this.scripts.setForce(true);
    // }
    return false;
  }

  fetchRequestFromCwd(): Promise<InstallCwdRequest> {
    return Install.prototype.fetchRequestFromCwd.call(this, this.siblingWorkspaces);
  }

  _iterateAddedPackages(
    f: (pattern: string, registry: string, dependencyType: string, pkgName: string, version: string) => void,
  ) {
    const patternOrigins = Object.keys(this.rootPatternsToOrigin);

    // add new patterns to their appropriate registry manifest
    for (const pattern of this.siblingWorkspaces) {
      const pkg = this.resolver.getResolvedPattern(pattern);
      invariant(pkg, `missing package ${pattern}`);
      const version = this.getPatternVersion(pattern, pkg);
      const ref = pkg._reference;
      invariant(ref, 'expected package reference');
      // lookup the package to determine dependency type; used during `yarn upgrade`
      const depType = patternOrigins.reduce((acc, prev) => {
        if (prev.indexOf(`${pkg.name}@`) === 0) {
          return this.rootPatternsToOrigin[prev];
        }
        return acc;
      }, null);

      // depType is calculated when `yarn upgrade` command is used
      const target = depType || this.flagToOrigin;

      f(pattern, ref.registry, target, pkg.name, version);
    }
  }
}

export function hasWrapper(commander: Object): boolean {
  return true;
}

export function setFlags(commander: Object) {
  commander.description('Installs sibling workspaces from the registry to allow working on a workspace in isolation.');
  commander.usage('isolate');
}

export async function run(config: Config, reporter: Reporter, flags: Object, args: Array<string>): Promise<void> {
  const lockfile = await Lockfile.fromDirectory(config.lockfileFolder, reporter);

  await wrapLifecycle(config, flags, async () => {
    const isolate = new Isolate(flags, config, reporter, lockfile);
    await isolate.init();
  });
}
