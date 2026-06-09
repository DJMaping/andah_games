(function () {
    var STORAGE_KEY = 'andah-theme';

    function currentTheme() {
        return document.documentElement.getAttribute('data-theme') || 'light';
    }

    function applyTheme(theme) {
        document.documentElement.setAttribute('data-theme', theme);
        try { localStorage.setItem(STORAGE_KEY, theme); } catch (e) {}
        updateToggleLabel(theme);
    }

    function updateToggleLabel(theme) {
        var btn = document.querySelector('.theme-toggle');
        if (!btn) return;
        var nextIsDark = theme !== 'dark';
        btn.textContent = nextIsDark ? '☾ Dark' : '☀ Light';
        btn.setAttribute('aria-label', nextIsDark ? 'Switch to dark mode' : 'Switch to light mode');
        btn.setAttribute('aria-pressed', String(theme === 'dark'));
    }

    function init() {
        var btn = document.querySelector('.theme-toggle');
        if (btn) {
            updateToggleLabel(currentTheme());
            btn.addEventListener('click', function () {
                applyTheme(currentTheme() === 'dark' ? 'light' : 'dark');
            });
        }
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
