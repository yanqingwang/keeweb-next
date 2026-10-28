/* eslint-env node */

const path = require('path');
const { execSync } = require('child_process');

const webpackConfig = require('./build/webpack.config');
const webpackConfigTest = require('./test/test.webpack.config');
const pkg = require('./package.json');

module.exports = function (grunt) {
    require('time-grunt')(grunt);
    require('load-grunt-tasks')(grunt);

    grunt.loadTasks('build/tasks');

    require('./grunt.tasks')(grunt);
    require('./grunt.entrypoints')(grunt);

    const date = new Date();
    grunt.config.set('date', date);

    const dt = date.toISOString().replace(/T.*/, '');
    let sha = grunt.option('commit-sha');
    if (!sha) {
        try {
            sha = execSync('git rev-parse --short HEAD').toString('utf8').trim();
        } catch (e) {
            grunt.warn(
                "Cannot get commit sha from git. It's recommended to build KeeWeb from a git repo " +
                    'because commit sha is displayed in the UI, however if you would like to build from a folder, ' +
                    'you can override what will be displayed in the UI with --commit-sha=xxx.'
            );
        }
    }
    grunt.log.writeln(`Building KeeWeb v${pkg.version} (${sha})`);

    const webpackOptions = {
        date,
        beta: !!grunt.option('beta'),
        sha
    };

    grunt.initConfig({
        noop: { noop: {} },
        clean: {
            dist: ['dist', 'tmp']
        },
        copy: {
            html: {
                src: 'app/index.html',
                dest: 'tmp/index.html',
                nonull: true
            },
            'content-dist': {
                cwd: 'app/content/',
                src: '**',
                dest: 'dist/',
                expand: true,
                nonull: true
            },
            icons: {
                cwd: 'app/icons/',
                src: ['*.png', '*.svg'],
                dest: 'tmp/icons/',
                expand: true,
                nonull: true
            },
            'dist-icons': {
                cwd: 'app/icons/',
                src: ['*.png', '*.svg'],
                dest: 'dist/icons/',
                expand: true,
                nonull: true
            },
            manifest: {
                cwd: 'app/manifest/',
                src: ['*.json', '*.xml'],
                dest: 'tmp/',
                expand: true,
                nonull: true
            },
            'dist-manifest': {
                cwd: 'app/manifest/',
                src: ['*.json', '*.xml'],
                dest: 'dist/',
                expand: true,
                nonull: true
            }
        },
        eslint: {
            app: ['app/scripts/**/*.js'],
            build: ['Gruntfile.js', 'grunt.*.js', 'build/**/*.js', 'webpack.config.js'],
            plugins: ['plugins/**/*.js'],
            util: ['util/**/*.js']
        },
        inline: {
            app: {
                src: 'tmp/index.html',
                dest: 'tmp/app.html'
            }
        },
        'csp-hashes': {
            options: {
                algo: 'sha512',
                expected: {
                    style: 1,
                    script: 1
                }
            },
            app: {
                src: 'tmp/app.html',
                dest: 'dist/index.html'
            }
        },
        htmlmin: {
            options: {
                removeComments: true,
                collapseWhitespace: true
            },
            app: {
                files: {
                    'tmp/app.html': 'tmp/app.html'
                }
            }
        },
        'string-replace': {
            'update-manifest': {
                options: {
                    replacements: [
                        {
                            pattern: /"version":\s*".*?"/,
                            replacement: `"version": "${pkg.version}"`
                        },
                        {
                            pattern: /"date":\s*".*?"/,
                            replacement: `"date": "${dt}"`
                        }
                    ]
                },
                files: { 'dist/update.json': 'app/update.json' }
            },
            'service-worker': {
                options: { replacements: [{ pattern: '0.0.0', replacement: pkg.version }] },
                files: { 'dist/service-worker.js': 'app/service-worker.js' }
            }
        },
        webpack: {
            app: webpackConfig.config(webpackOptions),
            test: webpackConfigTest
        },
        'webpack-dev-server': {
            options: {
                webpack: webpackConfig.config({
                    ...webpackOptions,
                    mode: 'development',
                    sha: 'dev'
                }),
                publicPath: '/',
                contentBase: [
                    path.resolve(__dirname, 'tmp'),
                    path.resolve(__dirname, 'app/content')
                ],
                progress: false
            },
            js: {
                keepalive: true,
                port: 8085
            }
        },
        'run-test': {
            options: {
                headless: true
            },
            default: 'test/runner.html'
        }
    });
};
