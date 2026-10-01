function toggleSidebar(open) {
  const sidebar = document.getElementById('appSidebar');
  const backdrop = document.getElementById('sidebarBackdrop');
  if (!sidebar || !backdrop) return;
  sidebar.classList.toggle('-translate-x-full', !open);
  backdrop.classList.toggle('hidden', !open);
  document.body.classList.toggle('overflow-hidden', open);
}

document.addEventListener('keydown', event => {
  if (event.key === 'Escape') toggleSidebar(false);
});

document.addEventListener('click', event => {
  const link = event.target.closest('#appSidebar a');
  if (link && window.innerWidth < 1024) toggleSidebar(false);
});
