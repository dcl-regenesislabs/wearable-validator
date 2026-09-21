// Batch-mode entry point for the validator's Web build of avatar-preview-renderer (unity-explorer PR #10053).
// Copied into the project's Assets/Editor by build.sh; not part of the previewer itself.
using System;
using UnityEditor;
using UnityEditor.Build.Reporting;

public static class ValidatorBuild
{
    public static void Web()
    {
        var args = Environment.GetCommandLineArgs();
        var index = Array.IndexOf(args, "-buildPath");
        var path = index >= 0 && index + 1 < args.Length ? args[index + 1] : "Builds/avatar-preview-renderer";
        // plain files: the validator's Docker image and readLocalBuild take them as they are
        PlayerSettings.WebGL.compressionFormat = WebGLCompressionFormat.Disabled;
        var report = BuildPipeline.BuildPlayer(new BuildPlayerOptions
        {
            scenes = new[] { "Assets/Scenes/Main.unity" },
            locationPathName = path,
            target = BuildTarget.WebGL,
            options = BuildOptions.None
        });
        if (report.summary.result != BuildResult.Succeeded)
            throw new Exception($"Web build {report.summary.result}: {report.summary.totalErrors} errors, see the log");
    }
}
