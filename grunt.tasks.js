module.exports = function (grunt) {
    // The web app is the product; the optional desktop shell is built by
    // Tauri (src-tauri/) and does not go through Grunt.

    grunt.registerTask('build-web-app', [
        'clean',
        'eslint',
        'copy:html',
        'copy:icons',
        'copy:manifest',
        'webpack:app',
        'inline',
        'htmlmin',
        'csp-hashes',
        'copy:content-dist',
        'string-replace:service-worker',
        'string-replace:update-manifest',
        'copy:dist-icons',
        'copy:dist-manifest'
    ]);

    grunt.registerTask('build-test', ['webpack:test']);
};
