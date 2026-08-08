const nativeMatchMedia = window.matchMedia.bind(window);

window.matchMedia = (query: string): MediaQueryList => {
  const media = nativeMatchMedia(query);
  if (query !== "(prefers-reduced-transparency: reduce)") return media;

  return {
    addEventListener: media.addEventListener.bind(media),
    addListener: media.addListener.bind(media),
    dispatchEvent: media.dispatchEvent.bind(media),
    matches: false,
    media: media.media,
    onchange: media.onchange,
    removeEventListener: media.removeEventListener.bind(media),
    removeListener: media.removeListener.bind(media),
  };
};
