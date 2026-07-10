const LANG_KEY = 'todo-lang';

const translations = {
    en: {
        settings: 'Settings',
        light_mode: 'Light mode',
        language: 'English',
        urgency_intensity: 'Urgency coloring intensity',
        main_color: 'Main color',
        bg_shade: 'Background shade',
        bg_pattern: 'Background pattern',
        pattern_none: 'None',
        pattern_grain: 'Grain',
        pattern_dots: 'Dots',
        pattern_grid: 'Grid',
        pattern_lines: 'Lines',
        pattern_scan: 'Scan',
        pattern_strength: 'Pattern strength',
        bg_photo: 'Background photo',
        choose_photo: 'Choose photo',
        remove: 'Remove',
        sign_out: 'Sign out',
        productivity: 'Productivity',
        loading: 'Loading…',
        tab_todo: 'Todo',
        tab_notes: 'Notes',
        tab_soon: 'Soon',
        tab_longrun: 'Long run',
        day_0: 'SUNDAY',
        day_1: 'MONDAY',
        day_2: 'TUESDAY',
        day_3: 'WEDNESDAY',
        day_4: 'THURSDAY',
        day_5: 'FRIDAY',
        day_6: 'SATURDAY',
        month_0: 'January',
        month_1: 'February',
        month_2: 'March',
        month_3: 'April',
        month_4: 'May',
        month_5: 'June',
        month_6: 'July',
        month_7: 'August',
        month_8: 'September',
        month_9: 'October',
        month_10: 'November',
        month_11: 'December',
        no_tasks: 'No tasks (tap to add)',
        no_items: 'No items (tap to add)',
        toggle_list: 'Toggle list',
        auth_created: 'Account created! Please sign in.',
        auth_err_wrong_credentials: 'Incorrect email or password.',
        auth_err_invalid_email: 'Please enter a valid email address.',
        auth_err_email_in_use: 'This email is already registered.',
        auth_err_weak_password: 'Password must be at least 6 characters.',
        auth_err_too_many: 'Too many attempts — please try again later.',
        auth_err_network: 'No connection — please check your internet.',
        auth_err_generic: 'Something went wrong. Please try again.',
    },
    de: {
        settings: 'Einstellungen',
        light_mode: 'Helles Design',
        language: 'Deutsch',
        urgency_intensity: 'Dringlichkeits-Färbung',
        main_color: 'Hauptfarbe',
        bg_shade: 'Hintergrundfarbe',
        bg_pattern: 'Hintergrundmuster',
        pattern_none: 'Keins',
        pattern_grain: 'Korn',
        pattern_dots: 'Punkte',
        pattern_grid: 'Raster',
        pattern_lines: 'Linien',
        pattern_scan: 'Scan',
        pattern_strength: 'Musterstärke',
        bg_photo: 'Hintergrundfoto',
        choose_photo: 'Foto wählen',
        remove: 'Entfernen',
        sign_out: 'Abmelden',
        productivity: 'Produktivität',
        loading: 'Lädt…',
        tab_todo: 'Todo',
        tab_notes: 'Notizen',
        tab_soon: 'Demnächst',
        tab_longrun: 'Langfristig',
        day_0: 'SONNTAG',
        day_1: 'MONTAG',
        day_2: 'DIENSTAG',
        day_3: 'MITTWOCH',
        day_4: 'DONNERSTAG',
        day_5: 'FREITAG',
        day_6: 'SAMSTAG',
        month_0: 'Januar',
        month_1: 'Februar',
        month_2: 'März',
        month_3: 'April',
        month_4: 'Mai',
        month_5: 'Juni',
        month_6: 'Juli',
        month_7: 'August',
        month_8: 'September',
        month_9: 'Oktober',
        month_10: 'November',
        month_11: 'Dezember',
        no_tasks: 'Keine Aufgaben (tippen zum Hinzufügen)',
        no_items: 'Keine Einträge (tippen zum Hinzufügen)',
        toggle_list: 'Ausklappliste',
        auth_created: 'Konto erstellt! Bitte anmelden.',
        auth_err_wrong_credentials: 'E-Mail oder Passwort ist falsch.',
        auth_err_invalid_email: 'Bitte eine gültige E-Mail-Adresse eingeben.',
        auth_err_email_in_use: 'Diese E-Mail ist bereits registriert.',
        auth_err_weak_password: 'Das Passwort braucht mindestens 6 Zeichen.',
        auth_err_too_many: 'Zu viele Versuche — bitte später erneut versuchen.',
        auth_err_network: 'Keine Verbindung — bitte Internet prüfen.',
        auth_err_generic: 'Etwas ist schiefgelaufen. Bitte erneut versuchen.',
    }
};

export function getLang() {
    return localStorage.getItem(LANG_KEY) || 'en';
}

export function setLang(lang) {
    localStorage.setItem(LANG_KEY, lang);
    applyTranslations();
    document.dispatchEvent(new CustomEvent('lang-changed'));
}

export function t(key) {
    const lang = getLang();
    return translations[lang]?.[key] ?? translations.en[key] ?? key;
}

export function applyTranslations() {
    document.querySelectorAll('[data-i18n]').forEach(el => {
        el.textContent = t(el.dataset.i18n);
    });
}
