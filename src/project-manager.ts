/// <reference path="../typings/node/node.d.ts"/>
/// <reference path="../typings/typescript/typescript.d.ts"/>
/// <reference path="../typings/async/async.d.ts"/>

import * as path_ from 'path';

import * as ts from 'typescript';
import { IConnection } from 'vscode-languageserver';
import * as async from 'async';

import * as FileSystem from './fs';
import * as util from './util';
import * as match from './match-files';

export class ProjectManager {

    private root: string;
    private strict: boolean;

    private defaultConfig: ProjectConfiguration;
    private configs: Map<string, ProjectConfiguration>;

    private remoteFs: FileSystem.FileSystem;
    private localFs: InMemoryFileSystem;

    constructor(root: string, strict: boolean, connection: IConnection) {
        this.root = util.normalizePath(root);
        this.strict = strict;
        this.configs = new Map<string, ProjectConfiguration>();
        this.localFs = new InMemoryFileSystem(this.root);

        if (strict) {
            this.remoteFs = new FileSystem.RemoteFileSystem(connection)
        } else {
            this.remoteFs = new FileSystem.LocalFileSystem(root)
        }
        const defaultHost = new InMemoryLanguageServiceHost(root, {
            module: ts.ModuleKind.CommonJS,
            allowNonTsExtensions: false,
            allowJs: false
        }, this.localFs, []);
        const defaultService = ts.createLanguageService(defaultHost, ts.createDocumentRegistry());
        this.defaultConfig = {
            service: defaultService,
            program: defaultService.getProgram(),
            host: defaultHost
        }
    }

    /**
     * Fetches directory tree and files from VFS, identifies and initializes sub-projects
     */
    initialize(): Promise<void> {

        let self = this;

        let done = false;

        return new Promise<void>(function (resolve, reject) {
            // fetch directory tree from VFS
            self.getFiles(self.root, function (err, files) {
                // HACK (callback is called twice) 
                if (done) {
                    return;
                }
                done = true;
                if (err) {
                    console.error('An error occurred while collecting files', err);
                    return reject(err);
                }
                // fetch files from VFS
                self.fetchContent(files, function (err) {
                    if (err) {
                        console.error('An error occurred while fetching files content', err);
                        return reject(err);
                    }

                    // Determine and initialize sub-projects
                    self.processProjects(function () {
                        return resolve();
                    });

                });
            });
        });
    }

    /**
     * @return true if there is a file with a given name
     */
    hasFile(name: string) {
        return this.localFs.fileExists(name);
    }

    /**
     * Ensures that all files are added (and parsed) to the project to which fileName belongs. 
     */
    syncConfigurationFor(fileName: string) {
        return this.syncConfiguration(this.getConfiguration(fileName));
    }

    /**
     * Ensures that all files are added (and parsed) for the given project.
     * Uses tsconfig.json settings to identify what files make a project (root files)
     */
    syncConfiguration(config: ProjectConfiguration) {
        if (config.host.complete) {
            return;
        }
        (config.host.getExpectedFiles() || []).forEach(function (fileName) {
            const sourceFile = config.program.getSourceFile(fileName);
            if (!sourceFile) {
                config.program.addFile(fileName);
                // requery program object to synchonize LanguageService's data   
                config.program = config.service.getProgram();
            }
        });
        config.host.complete = true;
    }

    /**
     * @return all projects
     */
    getConfigurations(): ProjectConfiguration[] {
        const ret = [];
        this.configs.forEach(function(v, k) {
            ret.push(v);
        });
        return ret;
    }

    // TODO: eliminate this method
    // we should process all subprojects instead
    getAnyConfiguration(): ProjectConfiguration {
        let config = null;
        this.configs.forEach(function (v) {
            if (!config) {
                config = v;
            }
        });
        return config || this.defaultConfig;
    }

    /**
     * Collects all files in the given path
     */
    getFiles(path: string, callback: (err: Error, result?: string[]) => void) {

        const start = new Date().getTime();

        let self = this;
        let files: string[] = [];
        let counter: number = 0;

        let cb = function (err: Error, result?: FileSystem.FileInfo[]) {
            if (err) {
                console.error('got error while reading dir', err);
                return callback(err)
            }
            let tasks = [];
            result.forEach(function (fi) {
                if (fi.Name_.indexOf('/.') >= 0) {
                    return
                }
                if (fi.Dir_) {
                    counter++;
                    tasks.push(self.fetchDir(fi.Name_))
                } else {
                    if (/\.[tj]sx?$/.test(fi.Name_) || /(^|\/)[tj]sconfig\.json$/.test(fi.Name_)) {
                        files.push(fi.Name_)
                    }
                }
            });
            async.parallel(tasks, function (err: Error, result?: FileSystem.FileInfo[][]) {
                if (err) {
                    return callback(err)
                }
                result.forEach((items) => {
                    counter--;
                    cb(null, items)
                });
                if (counter == 0) {
                    console.error(files.length + ' found, fs scan complete in', (new Date().getTime() - start) / 1000.0);
                    callback(null, files)
                }
            })
        };
        this.fetchDir(path)(cb)
    }
    
    /**
     * @return project configuration for a given source file. Climbs directory tree up to workspace root if needed 
     */
    getConfiguration(fileName: string): ProjectConfiguration {
        let dir = path_.posix.dirname(fileName);
        let config;
        while (dir && dir != this.root) {
            config = this.configs.get(dir);
            if (config) {
                return config;
            }
            dir = path_.posix.dirname(dir);
            if (dir == '.') {
                dir = '';
            }
        }
        config = this.configs.get(dir);
        return config || this.defaultConfig;
    }

    /**
     * @return asynchronous function that fetches directory content from VFS
     */
    private fetchDir(path: string): AsyncFunction<FileSystem.FileInfo[]> {
        let self = this;
        return function (callback: (err?: Error, result?: FileSystem.FileInfo[]) => void) {
            self.remoteFs.readDir(path, (err?: Error, result?: FileSystem.FileInfo[]) => {
                if (result) {
                    result.forEach(function (fi) {
                        fi.Name_ = path_.posix.join(path, fi.Name_)
                    })
                }
                return callback(err, result)
            });
        }
    }

    /**
     * Fetches content of the specified files
     */
    private fetchContent(files: string[], callback: (err?: Error) => void) {
        let tasks = [];
        const self = this;
        const fetch = function (path: string): AsyncFunction<string> {
            return function (callback: (err?: Error, result?: string) => void) {
                self.remoteFs.readFile(path, (err?: Error, result?: string) => {
                    if (err) {
                        console.error('Unable to fetch content of ' + path, err);
                        return callback(err)
                    }
                    const rel = path_.posix.relative(self.root, path);
                    self.localFs.addFile(rel, result);
                    return callback()
                })
            }
        };
        files.forEach(function (path) {
            tasks.push(fetch(path))
        });
        const start = new Date().getTime();
        // Why parallelLimit: There may be too many open files when working with local FS and trying
        // to open them in parallel
        async.parallelLimit(tasks, 100, function (err) {
            console.error('files fetched in', (new Date().getTime() - start) / 1000.0);
            return callback(err);
        });
    }

    /**
     * Detects projects denoted by tsconfig.json
     */
    private processProjects(callback: (err?: Error) => void) {
        let tasks = [];
        const self = this;
        Object.keys(this.localFs.entries).forEach(function (k) {
            if (!/(^|\/)tsconfig\.json$/.test(k)) {
                return;
            }
            if (/(^|\/)node_modules\//.test(k)) {
                return;
            }
            tasks.push(self.processProject(k, self.localFs.entries[k]));
        });
        async.parallel(tasks, callback);
    }

    /**
     * @return asynchronous function that processes TypeScript project
     */
    private processProject(tsConfigPath: string, tsConfigContent: string): AsyncFunction<void> {
        const self = this;
        return function (callback: (err?: Error) => void) {
            const jsonConfig = ts.parseConfigFileTextToJson(tsConfigPath, tsConfigContent);
            if (jsonConfig.error) {
                console.error('Cannot parse ' + tsConfigPath + ': ' + jsonConfig.error.messageText);
                return callback(new Error('Cannot parse ' + tsConfigPath + ': ' + jsonConfig.error.messageText));
            }
            const configObject = jsonConfig.config;
            let dir = path_.posix.dirname(tsConfigPath);
            if (dir == '.') {
                dir = '';
            }
            const base = dir || self.root;
            const configParseResult = ts.parseJsonConfigFileContent(configObject, self.localFs, base);
            console.error('Added project', tsConfigPath, dir);
            const host = new InMemoryLanguageServiceHost(self.root,
                configParseResult.options,
                self.localFs,
                configParseResult.fileNames);
            const service = ts.createLanguageService(host, ts.createDocumentRegistry());
            const program = service.getProgram();
            self.configs.set(dir, { service: service, host: host, program: program });
            callback();
        }
    }
}

/**
 * Implementaton of LanguageServiceHost that works with in-memory file system
 */
class InMemoryLanguageServiceHost implements ts.LanguageServiceHost {

    complete: boolean;

    private root: string;
    private options: ts.CompilerOptions;
    private fs: InMemoryFileSystem;
    private expectedFiles: string[];

    constructor(root: string, options: ts.CompilerOptions, fs: InMemoryFileSystem, expectedFiles: string[]) {
        this.root = root;
        this.options = options;
        this.fs = fs;
        this.expectedFiles = expectedFiles;
    }

    getCompilationSettings(): ts.CompilerOptions {
        return this.options;
    }

    getScriptFileNames(): string[] {
        return [];
    }

    getScriptVersion(fileName: string): string {
        const entry = this.getScriptSnapshot(fileName);
        return entry ? "1" : undefined;
    }

    getScriptSnapshot(fileName: string): ts.IScriptSnapshot {
        let entry = this.fs.readFile(fileName);
        if (!entry) {
            fileName = path_.posix.relative(this.root, fileName);
            entry = this.fs.readFile(fileName);
        }
        if (!entry) {
            return undefined;
        }
        return ts.ScriptSnapshot.fromString(entry);
    }

    getCurrentDirectory(): string {
        return this.root;
    }

    getDefaultLibFileName(options: ts.CompilerOptions): string {
        return ts.getDefaultLibFilePath(options);
    }

    getExpectedFiles() {
        return this.expectedFiles;
    }
}

/**
 * In-memory file system, can be served as a ParseConfigHost (thus allowing listing files that belong to project based on tsconfig.json options)
 */
class InMemoryFileSystem implements ts.ParseConfigHost {

    entries: any;

    useCaseSensitiveFileNames: boolean;

    private path: string;
    private rootNode: any;

    constructor(path: string) {
        this.path = path;
        this.entries = {};
        this.rootNode = {};
    }

    addFile(path: string, content: string) {
        this.entries[path] = content;
        let node = this.rootNode;
        path.split('/').forEach(function (component, i, components) {
            const n = node[component];
            if (!n) {
                node[component] = i == components.length - 1 ? '*' : {};
                node = node[component];
            } else {
                node = n;
            }
        });
    }

    fileExists(path: string): boolean {
        return !!this.entries[path];
    }

    readFile(path: string): string {
        return this.entries[path];
    }

    readDirectory(rootDir: string, extensions: string[], excludes: string[], includes: string[]): string[] {
        const self = this;
        return match.matchFiles(rootDir,
            extensions,
            excludes,
            includes,
            true,
            this.path,
            function () {
                return self.getFileSystemEntries.apply(self, arguments);
            });
    }

    getFileSystemEntries(path: string): match.FileSystemEntries {
        path = path_.posix.relative(this.path, path);
        const ret = { files: [], directories: [] };
        let node = this.rootNode;
        const components = path.split('/');
        if (components.length != 1 || components[0]) {
            components.forEach(function (component) {
                const n = node[component];
                if (!n) {
                    return ret;
                }
                node = n;
            });
        }
        Object.keys(node).forEach(function (name) {
            if (typeof node[name] == 'string') {
                ret.files.push(name);
            } else {
                ret.directories.push(name);
            }
        });
        return ret;
    }
}

/**
 * Project configuration holder
 */
export class ProjectConfiguration {
    service: ts.LanguageService;
    program: ts.Program;
    host: InMemoryLanguageServiceHost;
}