export const colors = {
    light: {
        bg: { page: '#fbf1c7', surface: '#ebdbb2', 'surface-alt': '#d5c4a1', raised: '#f9f5d7' },
        fg: { default: '#3c3836', muted: '#7c6f64', subtle: '#a89984', inverse: '#fbf1c7' },
        border: { default: '#bdae93', muted: '#d5c4a1', focus: '#b16286' },
        primary: { default: '#b16286', hover: '#9d6075', active: '#8a4e64', muted: 'rgba(177,98,134,0.12)' },
        accent: { default: '#d65d0e', hover: '#c04f08', active: '#a84306', muted: 'rgba(214,93,14,0.12)' },
        semantic: { info: '#458588', success: '#689d6a', warning: '#d79921', error: '#cc241d' },
        jewel: { amethyst: '#b16286', sapphire: '#458588', emerald: '#689d6a', ruby: '#cc241d', topaz: '#d79921', citrine: '#d65d0e', quartz: '#a89984' },
    },
    dark: {
        bg: { page: '#1d2021', surface: '#282828', 'surface-alt': '#3c3836', raised: '#32302f' },
        fg: { default: '#ebdbb2', muted: '#a89984', subtle: '#7c6f64', inverse: '#1d2021' },
        border: { default: '#504945', muted: '#3c3836', focus: '#b16286' },
        primary: { default: '#b16286', hover: '#c47a9a', active: '#d693b2', muted: 'rgba(177,98,134,0.2)' },
        accent: { default: '#d65d0e', hover: '#e06a15', active: '#ea7a20', muted: 'rgba(214,93,14,0.2)' },
        semantic: { info: '#83a598', success: '#8ec07c', warning: '#fabd2f', error: '#fb4934' },
        jewel: { amethyst: '#b16286', sapphire: '#83a598', emerald: '#8ec07c', ruby: '#fb4934', topaz: '#fabd2f', citrine: '#fe8019', quartz: '#a89984' },
    },
    mystic: {
        bg: { page: '#0e1014', surface: '#15181d', 'surface-alt': '#1c2128', raised: '#252b34' },
        fg: { default: '#e6e9ef', muted: '#aab1bd', subtle: '#8992a1', inverse: '#0e1014' },
        border: { default: '#697485', muted: '#343c48', focus: '#ac74ff' },
        primary: { default: '#ac74ff', hover: '#ba88ff', active: '#c9a0ff', muted: 'rgba(172,116,255,0.14)' },
        accent: { default: '#7e9fbd', hover: '#91afca', active: '#a7bfd4', muted: 'rgba(126,159,189,0.14)' },
        semantic: { info: '#76a0c2', success: '#7eae91', warning: '#c9a56a', error: '#ca7b82' },
        jewel: { amethyst: '#ac74ff', sapphire: '#76a0c2', emerald: '#7eae91', ruby: '#ca7b82', topaz: '#c9a56a', citrine: '#7e9fbd', quartz: '#8992a1' },
    },
    clay: {
        bg: { page: '#141414', surface: '#1a1a1a', 'surface-alt': '#222222', raised: '#262626' },
        fg: { default: '#ece9e5', muted: '#9c9893', subtle: '#6e6a65', inverse: '#0f0f0f' },
        border: { default: '#2a2a2a', muted: '#212121', focus: '#f2661a' },
        primary: { default: '#f2661a', hover: '#ff7f33', active: '#ff9a5c', muted: 'rgba(242,102,26,0.14)' },
        accent: { default: '#33b7a6', hover: '#4fd1bf', active: '#7ddccf', muted: 'rgba(51,183,166,0.14)' },
        semantic: { info: '#5ea8e8', success: '#6cc07f', warning: '#e3b341', error: '#e05252' },
        jewel: { amethyst: '#f2661a', sapphire: '#5ea8e8', emerald: '#6cc07f', ruby: '#e05252', topaz: '#e3b341', citrine: '#33b7a6', quartz: '#6e6a65' },
    },
    'clay-light': {
        bg: { page: '#f6f5f2', surface: '#fdfcf9', 'surface-alt': '#e9e7e2', raised: '#ffffff' },
        fg: { default: '#292723', muted: '#615c55', subtle: '#6b645b', inverse: '#f0eee9' },
        border: { default: '#d2cec6', muted: '#e5e1da', focus: '#9d4211' },
        primary: { default: '#9d4211', hover: '#84370e', active: '#6e2e0c', muted: 'rgba(157,66,17,0.12)' },
        accent: { default: '#1e6a60', hover: '#195951', active: '#154a43', muted: 'rgba(30,106,96,0.12)' },
        semantic: { info: '#3266a0', success: '#337146', warning: '#84600c', error: '#b63838' },
        jewel: { amethyst: '#9d4211', sapphire: '#376389', emerald: '#3a6845', ruby: '#a13b3b', topaz: '#745b21', citrine: '#1e6a60', quartz: '#625e5a' },
    },
};
/** Displacer's default theme, for products without a saved theme preference. */
export const defaultTheme = 'clay';
