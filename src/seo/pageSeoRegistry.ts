/**
 * Which non-blog pages have editable SEO, where it is stored, and what each
 * page shows when nothing is saved (its built-in "fallback").
 *
 * Pure data and pure functions, no imports: main-website's
 * `lib/seo/pageSeoParity.test.ts` imports this file and fails if any path,
 * fallback title or fallback description here differs from what the site
 * actually renders. The site owns the real values (lib/seo/routes.ts,
 * config/resources.ts, config/locationLandings.ts, lib/seo/pageSeo.ts); this
 * copy exists only so the admin can validate route keys and preview fallbacks.
 */

/** Where a page's SEO overrides live. */
export type SeoStorage =
  /** A `page_seo` row keyed by the canonical path (pages with no CMS record). */
  | 'page'
  /** The `about_page.seo_*` group. */
  | 'about'
  /** `courses.seo_*` on the course row. */
  | 'course'
  /** `comparisons.meta_title` / `meta_description`. */
  | 'comparison'
  /** `legal_docs.meta_title` / `meta_description`. */
  | 'legal';

export type PageKind = 'static' | 'about' | 'resource' | 'landing' | 'course' | 'comparison' | 'legal';

export interface SeoFallback {
  title: string;
  description: string;
}

export interface RegistryPage {
  path: string;
  kind: PageKind;
  storage: SeoStorage;
  label: string;
  /** Static fallback. Landings compute theirs from CMS data (landingFallback). */
  fallback?: SeoFallback;
  /** The page's code-owned search intent (STATIC_ROUTES.primaryIntent). */
  primaryIntent?: string;
  courseSlug?: string;
  localitySlug?: string;
}

/* ── Limits (server-enforced; the admin shows them) ───────────────────────── */

/** Hard maximum lengths. The database repeats them as CHECK constraints. */
export const SEO_LIMITS = {
  metaTitle: 120,
  metaDescription: 320,
  ogTitle: 120,
  ogDescription: 320,
  ogImageAlt: 200,
  keyword: 100,
  keywords: 10,
  intentNote: 500,
} as const;

/**
 * Display guidance only. Search engines truncate by pixel width, vary it by
 * device, and often rewrite titles and snippets; these ranges are what the
 * site's own on-page tests use as a sensible target, not ranking rules.
 */
export const SEO_GUIDANCE = {
  title: { min: 30, max: 60 },
  description: { min: 70, max: 160 },
} as const;

/* ── Fixed pages (main-website lib/seo/routes.ts → STATIC_ROUTES) ─────────── */

const STATIC_PAGES: RegistryPage[] = [
  {
    path: '/',
    kind: 'static',
    storage: 'page',
    label: 'Home',
    primaryIntent: 'IT training institute Hyderabad',
    fallback: {
      title: 'GloryTecks — IT Training Institute in Ameerpet, Hyderabad',
      description:
        'GloryTecks runs classroom and live online IT courses in Ameerpet, Hyderabad — Data Science, Generative AI, Python, Power BI, MLOps and Data Engineering — taught by working practitioners, with placement support and free demo classes.',
    },
  },
  {
    path: '/courses',
    kind: 'static',
    storage: 'page',
    label: 'Courses (catalogue)',
    primaryIntent: 'IT courses Hyderabad',
    fallback: {
      title: 'IT Courses in Hyderabad | GloryTecks',
      description:
        'Every course GloryTecks offers, in one place: Data Science, Generative AI, Agentic AI, MLOps, Python, Power BI, Data Analytics, Data Engineering and SQL Server. Compare duration, modules, tools and batch formats.',
    },
  },
  {
    path: '/training-in-hyderabad',
    kind: 'static',
    storage: 'page',
    label: 'Training centre (Ameerpet)',
    primaryIntent: 'IT training Ameerpet',
    fallback: {
      title: 'IT Training in Ameerpet, Hyderabad — GloryTecks Centre',
      description:
        'Visit the GloryTecks training centre in Ameerpet, a short walk from Ameerpet Metro Station. Classroom and weekend batches, opening hours, directions and the courses taught on site.',
    },
  },
  {
    path: '/placements',
    kind: 'static',
    storage: 'page',
    label: 'Placements',
    primaryIntent: 'GloryTecks placement support',
    fallback: {
      title: 'Placement Support at GloryTecks',
      description:
        'How GloryTecks supports the job search: career counselling, resume and ATS review, LinkedIn preparation, mock interviews and introductions to hiring partners — plus where past learners have been placed.',
    },
  },
  {
    path: '/about',
    kind: 'about',
    storage: 'about',
    label: 'About',
    primaryIntent: 'About GloryTecks',
    fallback: {
      title: 'About GloryTecks',
      description:
        'Who we are: an IT training institute in Ameerpet, Hyderabad, teaching Data Science, AI and analytics through project-based courses led by practitioners working in the field.',
    },
  },
  {
    path: '/contact',
    kind: 'static',
    storage: 'page',
    label: 'Contact',
    primaryIntent: 'GloryTecks contact',
    fallback: {
      title: 'Contact GloryTecks — Ameerpet, Hyderabad',
      description:
        'Phone, WhatsApp, email and directions for GloryTecks in Ameerpet, Hyderabad. Ask about course fees, upcoming batch dates, or book a free demo class.',
    },
  },
  {
    path: '/compare',
    kind: 'static',
    storage: 'page',
    label: 'Comparisons (hub)',
    primaryIntent: 'data career and tool comparisons',
    fallback: {
      title: 'Course and Tool Comparisons | GloryTecks',
      description:
        'Side-by-side comparisons to help you pick a track — Power BI vs Tableau, Data Science vs Data Analytics, Python vs R and more — with what each choice means for the Hyderabad job market.',
    },
  },
  {
    path: '/resources',
    kind: 'static',
    storage: 'page',
    label: 'Resources (hub)',
    primaryIntent: 'GloryTecks learning resources',
    fallback: {
      title: 'Free Learning Resources | GloryTecks',
      description:
        'Study material, an interview question bank, downloadable course notes, recorded video lectures and the Glory-AI assistant — the learning resources GloryTecks gives its students.',
    },
  },
  {
    path: '/entities',
    kind: 'static',
    storage: 'page',
    label: 'GloryTecks group brands',
    primaryIntent: 'GloryTecks group brands',
    fallback: {
      title: 'The GloryTecks Group — Academy, Labs, Careers and Foundation',
      description:
        'The GloryTecks family of brands — Academy, Labs, Careers, Enterprise, Foundation and Global — and what each one does.',
    },
  },
];

/* ── Resource detail pages (main-website config/resources.ts) ─────────────── */

const RESOURCES: { slug: string; title: string; desc: string }[] = [
  {
    slug: 'lms',
    title: 'Learning Management System',
    desc: 'Access all your enrolled course materials, assignments, and progress tracking in one unified LMS.',
  },
  {
    slug: 'glory-ai',
    title: 'Glory-AI Assistant',
    desc: 'Your 24/7 AI tutor that answers doubts, suggests resources, and helps you stay on track.',
  },
  {
    slug: 'interview-questions',
    title: 'Interview Questions Bank',
    desc: 'Curated, role-specific interview questions with model answers from real hiring rounds.',
  },
  {
    slug: 'course-material',
    title: 'Course Material Library',
    desc: 'Downloadable PDFs, cheatsheets, and reference materials for every module.',
  },
  {
    slug: 'video-lectures',
    title: 'Video Lecture Vault',
    desc: 'On-demand HD recordings of every session — revise anytime, on any device.',
  },
];

/** Mirrors /resources/[slug] generateMetadata. */
export const resourceFallback = (r: { title: string; desc: string }): SeoFallback => ({
  title: `${r.title} | GloryTecks Hyderabad`,
  description: r.desc,
});

const RESOURCE_PAGES: RegistryPage[] = RESOURCES.map((r) => ({
  path: `/resources/${r.slug}`,
  kind: 'resource',
  storage: 'page',
  label: `Resource — ${r.title}`,
  fallback: resourceFallback(r),
}));

/* ── Location landings (main-website config/locationLandings.ts) ──────────── */

const URL_COURSE_TOKEN: Record<string, string> = {
  'data-science': 'data-science',
  'data-analytics': 'data-analytics',
  'power-bi': 'power-bi',
  'python-programming': 'python',
  'gen-ai': 'generative-ai',
  mlops: 'mlops',
  'data-engineering': 'data-engineering',
  'agentic-ai': 'agentic-ai',
  'sql-server': 'sql-server',
};

const LANDING_COMBOS: [string, string[]][] = [
  ['data-science', ['ameerpet', 'kukatpally', 'madhapur', 'gachibowli', 'hitech-city', 'dilsukhnagar']],
  ['python-programming', ['ameerpet', 'kukatpally']],
  ['power-bi', ['ameerpet', 'kukatpally']],
  ['gen-ai', ['ameerpet', 'madhapur']],
  ['data-analytics', ['ameerpet', 'kukatpally']],
  ['mlops', ['ameerpet']],
  ['agentic-ai', ['ameerpet']],
  ['data-engineering', ['ameerpet']],
  ['sql-server', ['ameerpet']],
];

const LANDING_PAGES: RegistryPage[] = LANDING_COMBOS.flatMap(([courseSlug, localities]) =>
  localities.map((localitySlug) => ({
    path: `/${URL_COURSE_TOKEN[courseSlug]}-course-${localitySlug}`,
    kind: 'landing' as const,
    storage: 'page' as const,
    label: `Landing — ${courseSlug} × ${localitySlug}`,
    courseSlug,
    localitySlug,
  })),
);

export interface LandingInput {
  courseTitle: string;
  tagline: string;
  duration: string;
  localityName: string;
  localitySlug: string;
}

/** Mirrors main-website lib/seo/pageSeo.ts → landingFallback (parity-tested). */
export const landingFallback = (l: LandingInput): SeoFallback => {
  const duration = l.duration ? `, ${l.duration}` : '';
  return {
    title: `${l.courseTitle} Course in ${l.localityName}, Hyderabad | GloryTecks`,
    description:
      l.localitySlug === 'ameerpet'
        ? `${l.courseTitle} course in Ameerpet, Hyderabad${duration}: classroom batches at the GloryTecks centre near Ameerpet Metro, and live online. Placement support and a free demo class.`
        : `${l.courseTitle} course for learners in ${l.localityName}${duration}: live online batches, or classroom batches at the GloryTecks centre in Ameerpet. Placement support and a free demo class.`,
  };
};

export interface CourseInput {
  title: string;
  tagline: string;
  duration: string;
  modules: readonly string[];
  tools: readonly string[];
}

/** Mirrors main-website lib/seo/pageSeo.ts → courseFallback (parity-tested). */
export const courseFallback = (c: CourseInput): SeoFallback => {
  const t = c.tagline.trim();
  const tagline = t && !/[.!?]$/.test(t) ? `${t}.` : t;
  return {
    title: `${c.title} Course in Hyderabad | GloryTecks`,
    description: `${tagline ? `${tagline} ` : ''}${c.title} course in Hyderabad${c.duration ? `, ${c.duration}` : ''}: classroom batches at the Ameerpet centre and live online, with placement support.`,
  };
};

/**
 * Legal documents the site routes (main-website lib/seo/routes.ts →
 * LEGAL_ROUTES), each at `/<slug>`. A legal row with any other slug is not a
 * page on the site.
 */
export const LEGAL_SLUGS: readonly string[] = [
  'privacy-policy',
  'terms',
  'refund-policy',
  'cookie-policy',
  'disclaimer',
  'editorial-policy',
];

/** Mirrors main-website lib/seo/pageSeo.ts → comparisonFallback (parity-tested). */
export const comparisonFallback = (c: { title: string; intro: string }): SeoFallback => ({
  title: c.title,
  description:
    (c.intro.length > 160 ? `${c.intro.slice(0, 157)}...` : c.intro) ||
    'Side-by-side course and tool comparisons from GloryTecks Hyderabad.',
});

/* ── Lookups ──────────────────────────────────────────────────────────────── */

/** Every page whose overrides are stored by path (page_seo) or on about_page. */
export const ROUTE_KEYED_PAGES: readonly RegistryPage[] = [...STATIC_PAGES, ...RESOURCE_PAGES, ...LANDING_PAGES];

const BY_PATH = new Map(ROUTE_KEYED_PAGES.map((p) => [p.path, p]));

/** The registry entry for a route-keyed path, or undefined when it is not editable. */
export function routeKeyedPage(path: string): RegistryPage | undefined {
  return BY_PATH.get(path);
}

/** Paths whose overrides live in page_seo (everything route-keyed except /about). */
export const PAGE_SEO_PATHS: readonly string[] = ROUTE_KEYED_PAGES.filter((p) => p.storage === 'page').map(
  (p) => p.path,
);
