# npm Publishing Checklist

## Before First Publish

- [ ] **Create npm account** at https://www.npmjs.com/signup
- [ ] **Check package name**: `@adevguide/mcp-database-server` (scoped package)
- [ ] **Generate npm token**:
  1. Login to npm
  2. Profile → Access Tokens → Generate New Token
  3. Type: "Automation"
  4. Copy the token
- [ ] **Add token to GitHub Secrets**:
  1. Go to: https://github.com/iPraBhu/mcp-database-server/settings/secrets/actions
  2. Click "New repository secret"
  3. Name: `NPM_TOKEN`
  4. Value: [paste your token]
- [ ] **Commit GitHub Actions**:
  ```bash
  git add .github/ .npmignore package.json PUBLISHING.md
  git commit -m "Add GitHub Actions for npm publishing"
  git push origin main
  ```

## For Each Release

- [ ] **Update code** and commit changes
- [ ] **Run tests locally**:
  ```bash
  npm test -- --run
  npm run typecheck
  npm run lint
  npm run build
  ```
- [ ] **Update CHANGELOG.md** with new features/fixes
- [ ] **Bump version**:
  ```bash
  # For bug fixes
  npm version patch
  
  # For new features
  npm version minor
  
  # For breaking changes
  npm version major
  ```
- [ ] **Push with tags**:
  ```bash
  git push origin main --tags
  ```
- [ ] **Create GitHub Release**:
  1. Go to: https://github.com/iPraBhu/mcp-database-server/releases/new
  2. Select the tag you just created
  3. Title: `v1.0.0 - [Release Name]`
  4. Description: Copy from CHANGELOG.md
  5. Click "Publish release"
- [ ] **Wait for GitHub Actions** to complete
- [ ] **Verify on npm**:
  ```bash
  npm view @adevguide/mcp-database-server
  ```
- [ ] **Test installation**:
  ```bash
  npm install -g @adevguide/mcp-database-server@latest
  mcp-database-server --version
  ```

## Post-Publish

- [ ] **Announce release** on relevant channels
- [ ] **Update documentation** if needed
- [ ] **Monitor for issues** in GitHub Issues

## Quick Reference

```bash
# Check what will be published
npm pack --dry-run

# Publish manually (not recommended)
npm login
npm publish --access public

# View published package
npm view mcp-database-server

# Install globally
npm install -g mcp-database-server

# Check version
mcp-database-server --version
```

## Troubleshooting

**GitHub Action fails?**
- Check logs: https://github.com/iPraBhu/mcp-database-server/actions
- Ensure `NPM_TOKEN` secret is set correctly
- Verify tests pass locally

**Version already exists?**
- Bump version again: `npm version patch`
- Push: `git push origin main --tags`

**Permission denied?**
- Check npm token permissions
- Ensure token is "Automation" type
- Verify package name isn't taken

---

See [PUBLISHING.md](PUBLISHING.md) for detailed instructions.
