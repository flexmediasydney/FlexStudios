/**
 * app-params.js — Simplified for Supabase migration.
 *
 * Auth tokens are now managed by Supabase (stored in localStorage automatically).
 * This file is kept because @base44/vite-plugin reads appParams.
 * It will be removed entirely once the vite plugin is replaced.
 */

const isNode = typeof window === 'undefined';

const getAppParamValue = (paramName, { defaultValue = undefined } = {}) => {
	if (isNode) return defaultValue;
	return defaultValue || null;
}

export const appParams = {
	appId: getAppParamValue("app_id", { defaultValue: import.meta.env.VITE_BASE44_APP_ID }),
	token: null, // Supabase manages auth tokens internally
	fromUrl: isNode ? '' : window.location.href,
	functionsVersion: getAppParamValue("functions_version", { defaultValue: import.meta.env.VITE_BASE44_FUNCTIONS_VERSION }),
	appBaseUrl: getAppParamValue("app_base_url", { defaultValue: import.meta.env.VITE_BASE44_APP_BASE_URL }),
}
