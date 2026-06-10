## Summary

- 

## Changelog

<!--
Add `### <Heading>` + `- ` bullets between the markers below; the `changelog-sync`
workflow appends them to CHANGELOG.md under `## Unreleased` at PR time. Headings
must match CHANGELOG.md (Added / Changed / Fixed / Removed / Security /
Documentation). Leave the block empty, edit `## Unreleased` directly, or apply
the `skip-changelog` label for a deliberately non-user-visible change.
See docs/changelog-template.md ("Automated PR-body sync").
-->
<!-- pi-mmr changelog:start -->

<!-- pi-mmr changelog:end -->

## Verification

- [ ] `npm test`
- [ ] `npm run check`
- [ ] `npm run pack:dry-run` (when package contents, exports, or docs change)

## Linked issues

Closes #

## Follow-up work

- None known.

## Checklist

- [ ] I described user-visible changes in the Changelog marker block above (or edited `## Unreleased`), or this change is deliberately non-user-visible.
- [ ] I used labels that match the change type when practical.
- [ ] I did not include secrets, private session data, provider payloads, credentials, or local-only notes.
- [ ] Public-facing text uses `pi-mmr` project terms and is safe to publish.
