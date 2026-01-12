/**
 * Excel Cache Clear Script
 * 
 * Copy and paste this into Excel DevTools console to clear cache
 * 
 * Usage in Excel DevTools:
 *   1. Open Excel
 *   2. Open DevTools (Cmd+Option+I on Mac, F12 on Windows)
 *   3. Go to Console tab
 *   4. Paste this entire script
 *   5. Press Enter
 */

(function clearExcelCache() {
    console.log('🧹 Clearing Excel cache...');
    
    // Clear localStorage
    const keysToRemove = [];
    for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (key && (
            key.startsWith('xavi_') ||
            key.startsWith('netsuite_') ||
            key.startsWith('balance:') ||
            key.includes('preload') ||
            key.includes('manifest') ||
            key.includes('cache')
        )) {
            keysToRemove.push(key);
        }
    }
    
    keysToRemove.forEach(key => {
        localStorage.removeItem(key);
        console.log(`   Removed: ${key}`);
    });
    
    console.log(`✅ Cleared ${keysToRemove.length} cache entries`);
    console.log('🔄 Reloading...');
    
    // Reload the page
    setTimeout(() => {
        location.reload();
    }, 500);
})();
