// publish-plan.js — what publishing a file to a store will do (spec_files_store.md,
// « Publier ») : the version shown of the open file, as a module of the
// store (modules/<Name>/<Name>.dsp). Pure : unit-tested with
// node --test webapp/publish-plan.test.mjs.
//
//   refused : the code does not compile, a .lib file (the stores have no
//             libraries yet), a code that imports a .lib of faustcode (it
//             would not compile elsewhere) ;
//   new     : the path is free ;
//   version : the path is the module the file was opened from (or
//             published to), unchanged in the store since : a new version ;
//   changed : that module changed in the store since (someone else
//             published) : a new version anyway (theirs stays in the
//             history), or cancel ;
//   conflict: the path holds another module, the file is not linked to
//             it : a new version of it, or under another name (Name-2) ;
//   same    : the code is the last version of the store : nothing to
//             publish (the link is copied) ;
//   older   : the code is an older version of the store : publishing it
//             would take the module back.

/** The .lib a code imports (import("x.lib"), library("x.lib")). */
export function importedLibraries(code) {
  const libs = new Set();
  const re = /\b(?:import|library)\s*\(\s*"([^"]+\.lib)"\s*\)/g;
  for (let m; (m = re.exec(String(code))); ) libs.add(m[1]);
  return [...libs];
}

/**
 * @param {object} a
 * @param {string} a.name        the name of the file (Wahoo.dsp)
 * @param {string} a.code        its code (normalized)
 * @param {string} a.sha         the SHA-1 of the code
 * @param {string} a.errors      the errors of its compilation ('' if none)
 * @param {string} a.store       the store : "owner/repo"
 * @param {{modules: Array<{path, code?, versions?}>}} a.index  the index of the store (read just before)
 * @param {object|null} a.link   the link of the file to a store (file.store) or null
 * @param {Set<string>} a.userLibs  the names of the .lib files of faustcode
 * @param {(name: string) => string} a.modulePath  modules/<Name>/<Name>.dsp (fauststore)
 */
export function planPublication({ name, code, sha, errors, store, index, link, userLibs, modulePath }) {
  if (/\.lib$/i.test(name)) return { refused: 'lib' };
  if (errors && String(errors).trim()) return { refused: 'errors' };
  const imported = importedLibraries(code).filter((l) => userLibs.has(l));
  if (imported.length) return { refused: 'imports', libs: imported };

  const modules = (index && index.modules) || [];
  const at = (path) => modules.find((m) => m.path === path) || null;
  const linked = link && link.store === store ? link : null;
  const stem = name.replace(/\.dsp$/i, '');
  const path = linked ? linked.path : modulePath(stem);
  const entry = at(path);
  const free = () => {
    for (let n = 2; ; n++) {
      const p = modulePath(`${stem}-${n}`);
      if (!at(p)) return p;
    }
  };

  if (!entry) return { status: 'new', path };
  if (entry.code === sha) return { status: 'same', path };
  if ((entry.versions || []).some((v) => v.code === sha)) return { status: 'older', path };
  if (linked) {
    return entry.code === linked.code || !entry.code
      ? { status: 'version', path }
      : { status: 'changed', path };
  }
  return { status: 'conflict', path, other: free() };
}

/** The message of the commit. */
export function commitMessage(path, replaced) {
  const name = path.split('/').pop().replace(/\.dsp$/i, '');
  return `${replaced ? 'Publish a new version of' : 'Publish'} the module ${name} (faustcode)`;
}
