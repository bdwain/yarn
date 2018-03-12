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

  nonWorkspaceDeps: Array<string>;

  async init(): Promise<Array<string>> {
    // running "yarn isolate" in a workspace root is not allowed
    if (this.config.workspaceRootFolder && this.config.cwd === this.config.workspaceRootFolder) {
      throw new MessageError(this.reporter.lang('workspacesIsolateRootCheck'));
    }

    await this.setNonWorkspaceDeps();
    
    const patterns = await Install.prototype.init.call(this);
    return patterns;
  }

  async setNonWorkspaceDeps(): Array<string>{
    this.nonWorkspaceDeps = [];

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

    const allWorkspaces = Object.keys(await this.config.resolveWorkspaces(this.config.lockfileFolder, rootManifest));
    this.nonWorkspaceDeps = this._getAllWorkspaceDeps(workspaceManifest).filter(w => !allWorkspaces.includes(w));
  }

  _getAllWorkspaceDeps(manifest: Object): Array<string>{
    const depTypes = ['dependencies', 'devDependencies', 'optionalDependencies'];
    let result = [];
    depTypes.forEach(type => {
      if(!manifest[type]){
        return;
      }
      result = result.concat(Object.keys(manifest[type]));
    });
    return result;
  }

  fetchRequestFromCwd(): Promise<InstallCwdRequest> {
    return Install.prototype.fetchRequestFromCwd.call(this, this.nonWorkspaceDeps);
  }

  async bailout(patterns: Array<string>, workspaceLayout: ?WorkspaceLayout): Promise<boolean> {
    return false;
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
