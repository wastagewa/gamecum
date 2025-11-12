(function(){
  const THEME_KEY = 'imgur.theme';
  function applyTheme(theme){
    const root = document.documentElement;
    if(theme === 'dark'){
      root.setAttribute('data-theme','dark');
      root.style.colorScheme = 'dark';
    } else {
      root.removeAttribute('data-theme');
      root.style.colorScheme = 'light';
    }
    try{ localStorage.setItem(THEME_KEY, theme); }catch(e){}
    const btn = document.getElementById('themeToggle');
    if(btn){
      const isDark = theme === 'dark';
      btn.setAttribute('aria-pressed', String(isDark));
      btn.innerHTML = isDark
        ? '<i class="fas fa-sun"></i> Light'
        : '<i class="fas fa-moon"></i> Dark';
    }
  }
  function initTheme(){
    let saved = null;
    try{ saved = localStorage.getItem(THEME_KEY); }catch(e){}
    if(!saved){
      const prefersDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
      saved = prefersDark ? 'dark' : 'light';
    }
    applyTheme(saved);
  }
  // Apply as early as this file loads (button wiring still waits for DOM)
  initTheme();
  document.addEventListener('DOMContentLoaded', function(){
    const btn = document.getElementById('themeToggle');
    if(btn){
      btn.addEventListener('click', function(){
        const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
        applyTheme(isDark ? 'light' : 'dark');
      });
    }
  });
})();
