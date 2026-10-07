export function draftPrefix(username: string) {
  return `qingji:draft:${encodeURIComponent(username)}:`;
}
