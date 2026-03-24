export function createPageUrl(pageName: string) {
    // Support pageName containing query params (e.g. "ProjectDetails?id=123")
    const qIdx = pageName.indexOf('?');
    if (qIdx !== -1) {
        const base = pageName.substring(0, qIdx).replace(/ /g, '-');
        return '/' + base + pageName.substring(qIdx);
    }
    return '/' + pageName.replace(/ /g, '-');
}