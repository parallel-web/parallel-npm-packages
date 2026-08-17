#!/usr/bin/env bash
set -euo pipefail

# Release script for the @parallel-web npm packages monorepo.
#
# Each package is versioned and tagged independently — git tags are namespaced
# per package (e.g. ai-sdk-tools-v1.2.0) so packages never collide.
#
# Usage:
#   ./scripts/release.sh <package> rc        # bump to next RC (1.0.0 -> 1.1.0-rc.1, or 1.1.0-rc.1 -> 1.1.0-rc.2)
#   ./scripts/release.sh <package> stable    # promote current RC to stable (1.1.0-rc.2 -> 1.1.0)
#   ./scripts/release.sh <package> 1.2.0     # set an explicit version (X.Y.Z or X.Y.Z-rc.N)
#
#   <package> is the directory name under packages/, e.g.:
#     ai-sdk-tools | dsh-web-search | opencode-plugin | pi-extension
#
# What it does:
#   1. Computes the next version for that package
#   2. Updates packages/<package>/package.json
#   3. Creates a release/<package>-vX.Y.Z branch, commits, pushes, opens a PR
#
# When the PR merges to main, .github/workflows/release.yml publishes to npm
# (RCs under the `rc` dist-tag, stable under `latest`), creates the git tag
# <package>-vX.Y.Z, and cuts a GitHub Release.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

die() {
	echo "error: $*" >&2
	exit 1
}

usage() {
	echo "usage: ./scripts/release.sh <package> <rc|stable|X.Y.Z>"
	echo ""
	echo "  <package>  directory name under packages/ (publishable, non-private)"
	echo "  rc         bump to next release candidate"
	echo "  stable     promote current RC to stable"
	echo "  X.Y.Z      set explicit version (optionally X.Y.Z-rc.N)"
	echo ""
	echo "publishable packages:"
	for dir in "$PROJECT_ROOT"/packages/*/; do
		local_pkg="$(basename "$dir")"
		if [[ -f "$dir/package.json" ]] && [[ "$(node -p "require('$dir/package.json').private === true")" != "true" ]]; then
			echo "  - $local_pkg"
		fi
	done
}

get_current_version() {
	local pkg_json="$1"
	node -p "require('$pkg_json').version"
}

# Compute the next version from the current one (npm semver throughout).
calculate_next_version() {
	local current="$1"
	local bump_type="$2"

	case "$bump_type" in
	rc)
		if [[ "$current" =~ ^([0-9]+)\.([0-9]+)\.([0-9]+)-rc\.([0-9]+)$ ]]; then
			# Already an RC: increment the RC number
			echo "${BASH_REMATCH[1]}.${BASH_REMATCH[2]}.${BASH_REMATCH[3]}-rc.$((BASH_REMATCH[4] + 1))"
		elif [[ "$current" =~ ^([0-9]+)\.([0-9]+)\.([0-9]+)$ ]]; then
			# Stable: bump minor, start at rc.1
			echo "${BASH_REMATCH[1]}.$((BASH_REMATCH[2] + 1)).${BASH_REMATCH[3]}-rc.1"
		else
			die "cannot parse version: $current"
		fi
		;;
	stable)
		if [[ "$current" =~ ^([0-9]+\.[0-9]+\.[0-9]+)-rc\.[0-9]+$ ]]; then
			echo "${BASH_REMATCH[1]}"
		else
			die "current version ($current) is not an RC — nothing to promote"
		fi
		;;
	*)
		# Explicit version provided
		if [[ "$bump_type" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-rc\.[0-9]+)?$ ]]; then
			echo "$bump_type"
		else
			die "invalid version format: $bump_type (expected X.Y.Z or X.Y.Z-rc.N)"
		fi
		;;
	esac
}

# --- Main ---

if [[ $# -lt 2 ]]; then
	usage
	exit 1
fi

PACKAGE="$1"
BUMP_TYPE="$2"
PKG_DIR="$PROJECT_ROOT/packages/$PACKAGE"
PKG_JSON="$PKG_DIR/package.json"

[[ -f "$PKG_JSON" ]] || die "no package found at packages/$PACKAGE (see: ./scripts/release.sh)"
if [[ "$(node -p "require('$PKG_JSON').private === true")" == "true" ]]; then
	die "packages/$PACKAGE is private and is not published to npm"
fi

CURRENT_VERSION="$(get_current_version "$PKG_JSON")"
NEW_VERSION="$(calculate_next_version "$CURRENT_VERSION" "$BUMP_TYPE")"
TAG="${PACKAGE}-v${NEW_VERSION}"

IS_PRERELEASE=false
[[ "$NEW_VERSION" == *-rc.* ]] && IS_PRERELEASE=true

echo ""
echo "  package:          $PACKAGE"
echo "  current version:  $CURRENT_VERSION"
echo "  new version:      $NEW_VERSION"
echo "  tag:              $TAG"
echo "  dist-tag:         $([[ "$IS_PRERELEASE" == true ]] && echo rc || echo latest)"
echo "  prerelease:       $IS_PRERELEASE"
echo ""

# Safety checks
if [[ -n "$(git -C "$PROJECT_ROOT" status --porcelain)" ]]; then
	die "working tree is not clean — commit or stash changes first"
fi

CURRENT_BRANCH="$(git -C "$PROJECT_ROOT" branch --show-current)"
if [[ "$CURRENT_BRANCH" != "main" ]]; then
	die "must be on main branch (currently on $CURRENT_BRANCH)"
fi

git -C "$PROJECT_ROOT" fetch --tags --quiet origin || true
if git -C "$PROJECT_ROOT" rev-parse "$TAG" >/dev/null 2>&1; then
	die "tag $TAG already exists"
fi

read -r -p "proceed? [y/N] " confirm
if [[ "$confirm" != "y" && "$confirm" != "Y" ]]; then
	echo "aborted."
	exit 0
fi

# Update version in package.json (no git tag — the CI creates the namespaced tag)
(cd "$PKG_DIR" && npm version "$NEW_VERSION" --no-git-tag-version --allow-same-version >/dev/null)
echo "updated packages/$PACKAGE/package.json to $NEW_VERSION"

# Branch, commit, push, PR
BRANCH="release/${PACKAGE}-v${NEW_VERSION}"
COMMIT_MSG="chore($PACKAGE): bump version to $NEW_VERSION"

git -C "$PROJECT_ROOT" checkout -b "$BRANCH"
git -C "$PROJECT_ROOT" add "packages/$PACKAGE/package.json"
git -C "$PROJECT_ROOT" commit -m "$COMMIT_MSG"

echo ""
echo "pushing branch and creating PR..."
git -C "$PROJECT_ROOT" push -u origin "$BRANCH"

PRERELEASE_NOTE=""
[[ "$IS_PRERELEASE" == true ]] && PRERELEASE_NOTE=" (pre-release)"

gh pr create \
	--title "$COMMIT_MSG" \
	--body "$(
		cat <<EOF
## Release \`@parallel-web/$PACKAGE@$NEW_VERSION\`${PRERELEASE_NOTE}

Bumps \`$PACKAGE\` from \`$CURRENT_VERSION\` to \`$NEW_VERSION\`.

When this PR is merged to \`main\`, the release workflow will automatically:
- Build, lint, type-check and test \`packages/$PACKAGE\`
- Publish to npm under the \`$([[ "$IS_PRERELEASE" == true ]] && echo rc || echo latest)\` dist-tag (trusted publishing / OIDC)
- Create the git tag \`$TAG\`
- Cut a GitHub Release
EOF
	)"

echo ""
echo "done! merge the PR to trigger the release of @parallel-web/$PACKAGE@$NEW_VERSION."
