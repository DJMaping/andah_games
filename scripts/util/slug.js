// Shared name <-> slug <-> wiki-title rules.
// Used by both build scripts and runtime view code (via duplication kept in sync).
// When changing rules here, mirror them in any client-side equivalent.

export function toSlug(name) {
    return String(name)
        .trim()
        .toLowerCase()
        .replace(/\s+/g, '-')
        .replace(/[^a-z0-9\-]/g, '');
}

export function toWikiTitle(name) {
    // MediaWiki convention: spaces become underscores, first char uppercased.
    const trimmed = String(name).trim();
    if (!trimmed) return '';
    const underscored = trimmed.replace(/\s+/g, '_');
    return underscored.charAt(0).toUpperCase() + underscored.slice(1);
}

export function fromWikiTitle(title) {
    return String(title).replace(/_/g, ' ');
}
