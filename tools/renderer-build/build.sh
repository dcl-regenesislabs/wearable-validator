#!/bin/sh
# Builds the previewer for the validator from a unity-explorer checkout and prints the four files' folder.
# usage: tools/renderer-build/build.sh <unity-explorer dir> [<output dir>]
set -eu
project="$1/avatar-preview-renderer"
out="${2:-$PWD/tools/artifacts/avatar-preview-renderer}"
unity="${UNITY:-/Applications/Unity/Hub/Editor/6000.5.9f1/Unity.app/Contents/MacOS/Unity}"
mkdir -p "$project/Assets/Editor" "$(dirname "$out")"
cp "$(dirname "$0")/ValidatorBuild.cs" "$project/Assets/Editor/ValidatorBuild.cs"
"$unity" -batchmode -nographics -quit -projectPath "$project" -executeMethod ValidatorBuild.Web -buildPath "$out" -logFile "${LOG:-$out.log}"
ls "$out/Build"
