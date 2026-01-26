# Publishing to npm - Setup Guide

This guide explains how to publish the `@adevguide/mcp-database-server` package to npm using GitHub Actions.

## Prerequisites

1. **npm Account**: You need an npm account. Create one at https://www.npmjs.com/signup
2. **npm Organization**: Create organization `adevguide` at https://www.npmjs.com/org/create (free for public packages)
3. **Package Name**: `@adevguide/mcp-database-server` (scoped package - namespace protected)
4. **GitHub Repository**: Your code is already on GitHub at `iPraBhu/mcp-database-server`

> **Note about Scoped Packages**: The `@adevguide/` scope provides namespace protection. All packages under `@adevguide/*` will belong to your organization, making it easier to publish multiple related packages.

## Setup Steps

### 1. Create npm Access Token

1. **Log in to npm**: Visit https://www.npmjs.com and log in
2. **Go to Access Tokens**: Click your profile → "Access Tokens"
3. **Generate New Token**:
   - Click "Generate New Token" → "Classic Token"
   - **Type**: Select "Automation" (for CI/CD)
   - **Name**: `github-actions-adevguide-mcp-database-server`
   - Click "Generate Token"
4. **Copy the Token**: Copy it immediately (you won't see it again)

### 2. Add npm Token to GitHub Secrets

1. **Go to Repository Settings**:
   ```
   https://github.com/iPraBhu/mcp-database-server/settings/secrets/actions
   ```

2. **Create New Secret**:
   - Click "New repository secret"
   - **Name**: `NPM_TOKEN`
   - **Value**: Paste the npm token you copied
   - Click "Add secret"

### 3. Verify package.json Configuration

The package.json has been updated with:

```json
{
  "name": "@adevguide/mcp-database-server",
  "version": "1.0.0",
  "author": "iPraBhu",
  "repository": {
    "type": "git",
    "url": "git+https://github.com/iPraBhu/mcp-database-server.git"
  },
  "files": [
    "dist",
    "README.md",
    "LICENSE",
    "mcp-database-server.config.example"
  ]
}
```

### 4. Commit and Push GitHub Actions

The following workflow files have been created:

**`.github/workflows/publish.yml`** - Publishes to npm when you create a release
**`.github/workflows/ci.yml`** - Runs tests on every push and PR

Commit and push these files:

```bash
git add .github/workflows/
git add package.json
git commit -m "Add GitHub Actions for npm publishing and CI"
git push origin main
```

## Publishing Process

### Method 1: Create a GitHub Release (Recommended)

1. **Update Version** (if needed):
   ```bash
   npm version patch  # 1.0.0 → 1.0.1
   # or
   npm version minor  # 1.0.0 → 1.1.0
   # or
   npm version major  # 1.0.0 → 2.0.0
   ```

2. **Push Version Tag**:
   ```bash
   git push origin main --tags
   ```

3. **Create GitHub Release**:
   - Go to: https://github.com/iPraBhu/mcp-database-server/releases/new
   - **Tag**: Select the version tag (e.g., `v1.0.0`)
   - **Title**: `v1.0.0 - Initial Release`
   - **Description**: Write release notes
   - Click "Publish release"

4. **Automatic Publishing**:
   - GitHub Actions will automatically run
   - Tests will execute
   - Package will be built
   - Published to npm (if all checks pass)

### Method 2: Manual Trigger

You can also manually trigger the publish workflow:

1. Go to: https://github.com/iPraBhu/mcp-database-server/actions
2. Click "Publish to npm" workflow
3. Click "Run workflow" → Select branch → "Run workflow"

### Method 3: Local Publishing (Not Recommended)

```bash
npm login
npm run build
npm publish --access public
```

## What the Workflows Do

### Publish Workflow (`.github/workflows/publish.yml`)

**Triggers**:
- When you create a GitHub release
- Manual trigger via GitHub Actions UI

**Steps**:
1. ✅ Checks out code
2. ✅ Sets up Node.js 18
3. ✅ Installs dependencies (`npm ci`)
4. ✅ Runs tests (`npm test`)
5. ✅ Runs type checking (`npm run typecheck`)
6. ✅ Runs linter (`npm run lint`)
7. ✅ Builds project (`npm run build`)
8. ✅ Publishes to npm with provenance

**Features**:
- **Provenance**: Adds cryptographic proof of where package was built
- **Access**: Public package (anyone can install)
- **Quality Gates**: Won't publish if tests/lint fail

### CI Workflow (`.github/workflows/ci.yml`)

**Triggers**:
- Every push to `main` branch
- Every pull request to `main`

**Steps**:
1. ✅ Tests on Node.js 18, 20, and 22
2. ✅ Runs type checking
3. ✅ Runs linter
4. ✅ Runs tests
5. ✅ Builds project
6. ✅ Generates coverage report

**Benefits**:
- Catches issues before merging
- Ensures compatibility across Node versions
- Maintains code quality

## Versioning Strategy

Follow [Semantic Versioning](https://semver.org/):

- **MAJOR** (1.0.0 → 2.0.0): Breaking changes
- **MINOR** (1.0.0 → 1.1.0): New features (backward compatible)
- **PATCH** (1.0.0 → 1.0.1): Bug fixes

**Example Workflow**:

```bash
# Fix a bug
npm version patch
git push origin main --tags

# Add new feature
npm version minor
git push origin main --tags

# Breaking change
npm version major
git push origin main --tags
```

## Verifying Publication

After publishing, verify:

1. **npm Registry**:
   ```bash
   npm view @adevguide/mcp-database-server
   ```

2. **npm Website**: Visit https://www.npmjs.com/package/@adevguide/mcp-database-server

3. **Test Installation**:
   ```bash
   npm install -g @adevguide/mcp-database-server
   mcp-database-server --version
   ```

## Troubleshooting

### Error: "You do not have permission to publish"

**Solution**: Make sure:
- Package name is available (not taken)
- npm token is correct
- Token has "Automation" permissions

### Error: "Package name too similar to existing package"

**Solution**: Change package name in `package.json`

### Workflow Fails on Tests

**Solution**:
- Run tests locally: `npm test -- --run`
- Fix failing tests
- Commit and push fixes

### Version Already Exists

**Solution**:
```bash
npm version patch  # Increment version
git push origin main --tags
```

## Security Best Practices

1. ✅ **Never commit npm tokens** to git
2. ✅ Use GitHub Secrets for sensitive data
3. ✅ Enable 2FA on your npm account
4. ✅ Use "Automation" tokens (not "Publish" tokens)
5. ✅ Regularly rotate access tokens
6. ✅ Review package contents before publishing:
   ```bash
   npm pack --dry-run
   ```

## Package Contents

The published package will include:

```
@adevguide/mcp-database-server@1.0.0
├── dist/                           # Compiled JavaScript
│   ├── index.js
│   ├── index.d.ts
│   └── ...
├── README.md                       # Documentation
├── LICENSE                         # MIT License
└── mcp-database-server.config.example  # Example config
```

**What's excluded** (via `.gitignore` and `.npmignore`):
- `node_modules/`
- `src/` (TypeScript source - only dist is published)
- Test files
- Development configs

## Updating README Badges

After first publish, add badges to README.md:

```markdown
[![npm version](https://badge.fury.io/js/%40adevguide%2Fmcp-database-server.svg)](https://www.npmjs.com/package/@adevguide/mcp-database-server)
[![CI](https://github.com/iPraBhu/mcp-database-server/workflows/CI/badge.svg)](https://github.com/iPraBhu/mcp-database-server/actions)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
```

## Next Steps

1. ✅ Set up npm token in GitHub Secrets
2. ✅ Push GitHub Actions workflows
3. ✅ Create your first release
4. ✅ Verify package on npm
5. ✅ Update README with installation instructions
6. ✅ Share with the community!

## Support

For issues:
- GitHub Actions: Check workflow logs in the "Actions" tab
- npm Publishing: Check https://status.npmjs.org/
- Package Issues: Open an issue on GitHub

---

**Ready to publish?** Follow steps 1-4 above, then create your first release! 🚀
