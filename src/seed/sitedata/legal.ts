// ─────────────────────────────────────────────────────────────────────────
// Policy / trust pages: privacy, terms, refund, cookie, disclaimer, editorial.
//
// REVIEWED DRAFT, 2026-10-16 (phase A5) — NOT YET LIVE.
//
// The live text is in the CMS (legal_docs) and is shown by this Next.js site.
// Until this draft is approved it still shows the June 2026 text inherited
// from the legacy website. That text describes the legacy site's cookie banner
// and Consent Mode, which this site dropped, and it states refund rules and
// authorship that are not confirmed. Microsoft Clarity is set up in Google Tag
// Manager (and in the legacy site's own snippet), but both sites' Content-
// Security-Policy blocks its script, so it never runs and is not described here;
// main-website/lib/seo/legalPolicies.test.ts keeps these policies in step with
// the CSP.
// (glorytecks.com still serves the legacy site, whose policies are hard-coded
// in its bundle, so applying this draft does not change the domain until the
// cutover.) Decision D1 in the review doc — restoring the banner — changes the
// consent paragraphs below. This file is the corrected draft; it reaches the
// CMS only through `npx tsx src/scripts/legal-docs.ts apply …` (or by an admin
// pasting it in), after the approvals listed in
// main-website/docs/LEGAL_POLICY_REVIEW.md. It is also what `npm run seed`
// writes to a LOCAL database.
//
// Every statement below is either confirmed in the code and settings (the
// review doc lists the evidence) or marked:
//   REVIEW(legal)    — wording to be checked by an Indian legal professional
//   REVIEW(business) — a fact or commitment the business must confirm
// This is a draft prepared with AI assistance, not legal advice.
//
// Contact constants match main-website/config/business.ts. The CMS Settings
// currently show a different street number and email (open conflict CR-1);
// resolve that first and update all three places together.
// ─────────────────────────────────────────────────────────────────────────

export type LegalSection = {
  heading: string;
  paragraphs?: string[];
  bullets?: string[];
};

export type LegalDoc = {
  slug: string;
  title: string;
  metaTitle: string;
  metaDescription: string;
  updated: string; // ISO date (YYYY-MM-DD) of the last change to the text
  intro: string;
  sections: LegalSection[];
};

const ADDRESS = "611, Annapurna Block, Aditya Enclave, Ameerpet, Hyderabad – 500038, Telangana, India";
const PHONE = "+91 99080 99980";
const EMAIL = "info@glorytecks.com";

/**
 * The date this revision of the text was written. `legal-docs.ts apply`
 * replaces it with the real publication date (`--effective-date`), so the
 * live page never shows a date earlier than the text it heads.
 */
export const REVISION_DATE = "2026-10-16";

const contactSection: LegalSection = {
  heading: "Contact Us",
  paragraphs: [
    `If you have any questions about this document, contact GloryTecks by email at ${EMAIL}, by phone at ${PHONE}, or in person at ${ADDRESS}.`,
  ],
};

export const legalDocs: LegalDoc[] = [
  /* ── Privacy Policy ───────────────────────────────────────────────────── */
  {
    slug: "privacy-policy",
    title: "Privacy Policy",
    metaTitle: "Privacy Policy | GloryTecks IT Training Institute Hyderabad",
    metaDescription:
      "What personal information GloryTecks collects through its website forms and chat, how it is used and shared, how long it is kept, and how to make a request.",
    updated: REVISION_DATE,
    intro:
      "This policy explains what personal information GloryTecks (\"we\", \"us\") collects when you use this website or contact us through it, why we collect it, who it is shared with, how long we keep it and how you can contact us about it.",
    sections: [
      {
        heading: "Who We Are",
        paragraphs: [
          // REVIEW(business): add the legal entity name (company, LLP or proprietor) and its registered address.
          "GloryTecks is an IT training institute in Ameerpet, Hyderabad, India. We decide how the personal information described in this policy is used. Our contact details are at the end of this policy.",
        ],
      },
      {
        heading: "Information We Collect",
        paragraphs: ["We collect the information you choose to send us, plus some technical information when you browse:"],
        bullets: [
          "Contact form: your name, email address, phone number, the course you select (optional) and your message.",
          "Course enquiry form on a course page: your name, email address, phone number, an optional message, and the course of the page you were on.",
          "Free demo form: your name, phone number and the course you choose (optional), and which button you used to open the form.",
          "Chat assistant: your name and the address of the page where you started the chat, then — only if you choose to answer — the course you are interested in, your phone number, email address, your current profile (for example student or working professional) and whether you prefer online or classroom training. Each answer is saved as you give it, so an unfinished chat is still kept.",
          "Calls and WhatsApp messages: the details you choose to share with us when you call or message us.",
          "Technical information: when you visit, our servers record your IP address, your browser and device type, the page you asked for and the page that linked to it. Google Analytics also collects information about how you use the site — see \"Analytics and Similar Technologies\" below.",
          "We do not ask for payment details, identity documents or passwords on this website.",
        ],
      },
      {
        heading: "How We Use Your Information",
        bullets: [
          "To reply to your enquiry, arrange a demo class and talk to you about the courses you asked about, by phone, WhatsApp or email.",
          "To keep a record of enquiries so our team can follow them up.",
          "To understand how the website is used and to improve it, using Google Analytics, described below.",
          "To keep the website secure, prevent abuse such as spam form submissions, and fix problems.",
          // REVIEW(business): if you send promotional messages beyond replying to an enquiry, describe them here and collect consent for them first.
          "To comply with our legal obligations.",
        ],
      },
      {
        heading: "When You Choose WhatsApp",
        paragraphs: [
          "If you use a WhatsApp button, or choose WhatsApp when booking a demo, WhatsApp opens with a message containing the details you entered, such as your name, phone number and course. Messages you send through WhatsApp are handled by WhatsApp under its own terms and privacy policy.",
        ],
      },
      {
        heading: "Analytics and Similar Technologies",
        paragraphs: [
          // REVIEW(business): confirm whether Google Signals or a Google Ads link is enabled in Google Analytics. Microsoft Clarity is set up in Google Tag Manager, but the site's Content-Security-Policy blocks it, so it does not run; to use it, allow it in the CSP and describe it here and in the Cookie Policy first.
          "Every page of this website loads Google Analytics 4, which measures visits and how pages are used, and Google Tag Manager. Google Analytics uses cookies and similar identifiers and sends this information to Google.",
          // REVIEW(legal): analytics without a consent step — see the consent dependency in the review doc.
          // D1: if the legacy consent banner is restored before publishing, rewrite this paragraph to describe it.
          "Google Analytics starts when a page opens. This website does not currently show a cookie banner or offer an on-site switch to turn it off; our Cookie Policy explains the cookies involved and how to block them in your browser.",
          "When you submit a form or use a call or WhatsApp button, we record that event in Google Analytics without your name, phone number or email address.",
        ],
      },
      {
        heading: "Embedded Content",
        paragraphs: [
          "Some pages show a Google Maps map of our location, and the home page plays an introductory YouTube video. This content is loaded from Google, which receives information such as your IP address when it loads and may set its own cookies.",
        ],
      },
      {
        heading: "Who We Share Information With",
        paragraphs: ["We do not sell your personal information. We share it only with:"],
        bullets: [
          "Service providers that run our website and systems for us: Vercel (website and server hosting), Supabase (database), Redis Cloud (caching and abuse prevention) and Cloudinary (images and documents shown on the site).",
          "Google, through Google Analytics and the embedded content described above.",
          "Authorities, when the law requires us to.",
        ],
      },
      {
        heading: "Where Your Information Is Stored",
        paragraphs: [
          // REVIEW(legal): cross-border wording. Re-check the hosting regions at publication: database ap-northeast-1 (Tokyo), server functions iad1 (United States) on 2026-10-16.
          "Our service providers store and process information on servers outside India: our database is hosted in Japan and our website servers run in the United States. Analytics data is processed by Google on its own infrastructure.",
        ],
      },
      {
        heading: "How Long We Keep It",
        paragraphs: [
          // REVIEW(business): decide a fixed retention period for enquiries (there is no automatic deletion today) and, if one is published, schedule the deletion.
          "We keep enquiry records for as long as we need them to deal with and follow up your enquiry, and for any longer period the law requires. You can ask us to delete your details at any time — see \"Your Rights and Choices\". Server logs are kept by our hosting provider for a limited period, and analytics data according to the retention settings of Google Analytics.",
        ],
      },
      {
        heading: "Security",
        paragraphs: [
          "Your details are sent to us over an encrypted (HTTPS) connection. Enquiry records can be opened only by authorised GloryTecks staff, through password-protected accounts with role-based permissions, and our database refuses access to anyone not using our server's credentials. No method of storing or sending information online is completely secure, so we cannot promise that it will never be accessed without authorisation.",
        ],
      },
      {
        heading: "Your Rights and Choices",
        paragraphs: ["You can ask us to:"],
        bullets: [
          "tell you what personal information we hold about you and how we use it, and give you a copy;",
          "correct or update information that is inaccurate, incomplete or out of date;",
          "delete your information, unless we need to keep it to comply with the law;",
          "stop contacting you about your enquiry;",
          "deal with a person you nominate to exercise these rights on your behalf.",
        ],
      },
      {
        heading: "Making a Request or Complaint",
        paragraphs: [
          // REVIEW(business): name the person or designated officer who answers these requests (DPDP Act s.8(9); DPDP Rules 2025 r.9).
          `Send your request or complaint to ${EMAIL}, mentioning "Privacy request", or use the other contact details below. We may ask you to confirm your identity before acting on a request.`,
          // REVIEW(legal): response period (the DPDP Rules 2025 provide 90 days once rules 5–16 apply, expected from May 2027) and when the Board complaint route is available.
          "We will respond within the time required by law. If you are not satisfied with our response, you may also be able to complain to the Data Protection Board of India.",
        ],
      },
      {
        heading: "Children",
        paragraphs: [
          // REVIEW(legal): under the DPDP Act a child is anyone under 18; confirm the parental-consent process if minors enrol (rule 10 applies from May 2027).
          "This website is not directed at children. If you are under 18, please ask a parent or guardian to contact us on your behalf.",
        ],
      },
      {
        heading: "Third-Party Links",
        paragraphs: [
          "Our website links to other sites, such as YouTube, LinkedIn and WhatsApp. Their own privacy policies apply when you use them.",
        ],
      },
      {
        heading: "Changes to This Policy",
        paragraphs: [
          "We update the \"Last updated\" date at the top of this page whenever this policy changes.",
        ],
      },
      contactSection,
    ],
  },

  /* ── Terms of Service ─────────────────────────────────────────────────── */
  {
    slug: "terms",
    title: "Terms of Service",
    metaTitle: "Terms of Service | GloryTecks IT Training Institute Hyderabad",
    metaDescription:
      "The terms that apply when you use the GloryTecks website and when you enrol in a GloryTecks IT training course in Hyderabad.",
    updated: REVISION_DATE,
    intro:
      // REVIEW(legal): acceptance wording for website use versus enrolment.
      "These terms apply when you use the GloryTecks website. If you enrol in a course, the sections on courses, enrolment and fees also apply, together with any written terms we give you when you enrol. By using the website you agree to these terms.",
    sections: [
      {
        heading: "Course Information",
        paragraphs: [
          "Course pages describe each course's topics, tools and typical duration. We update courses to keep them current, so content, trainers, schedules and formats can change. The details confirmed with you when you enrol are the ones that apply to your batch.",
        ],
      },
      {
        heading: "Enrolment",
        paragraphs: [
          // REVIEW(business): confirm that enrolment terms (course, batch, fees, refund and transfer terms) are always confirmed in writing before payment.
          "You cannot enrol in a course or pay for one through this website. To enrol, contact us; we will confirm the course, batch, fees and payment terms with you before you pay.",
        ],
      },
      {
        heading: "Fees & Payments",
        bullets: [
          // REVIEW(business): the /courses page mentions instalment amounts that are not confirmed (A0 finding); align it with this clause.
          "The fees and payment terms for your enrolment are those confirmed with you before you pay. Any fee or instalment figure shown on the website is indicative until it is confirmed.",
          "Discounts and scholarships, where offered, are at our discretion and subject to eligibility.",
          "Refunds, cancellations and batch transfers are covered by our Refund Policy.",
        ],
      },
      {
        heading: "Learner Responsibilities",
        bullets: [
          "Give us accurate information when you enquire or enrol.",
          "Attend sessions and complete the practice work; how much you gain from a course depends on your own effort.",
          "If you are given access to recordings, learning materials or an online platform, use it only for your own learning and keep your access to yourself.",
          "Treat trainers, staff and other learners with respect.",
        ],
      },
      {
        heading: "Placement Assistance",
        paragraphs: [
          // REVIEW(business): confirm which courses include placement support and what it consists of.
          "Where a course includes placement assistance, it can include help with your resume, interview practice and introductions to employers. It is a support service, not a promise of a job: hiring decisions are made by employers and depend on your skills, your interview performance and the job market.",
        ],
      },
      {
        heading: "Intellectual Property",
        paragraphs: [
          "The website's content, our course materials and recordings, and the GloryTecks name and logo belong to GloryTecks or to those who licensed them to us. You may use course materials for your own learning. You may not copy, share, sell or publish them without our written permission.",
        ],
      },
      {
        heading: "Acceptable Use",
        bullets: [
          "Use the website lawfully and for its intended purpose.",
          "Do not try to disrupt, overload or gain unauthorised access to the website or our systems.",
          "Do not submit false information, or another person's details without their permission, in our forms.",
          "Do not copy substantial parts of the website for republication.",
        ],
      },
      {
        heading: "Website Availability",
        paragraphs: [
          // REVIEW(legal): "as is" wording under Indian consumer law.
          "We work to keep the website accurate and available, but it is provided as it is. Content may change and the website may sometimes be unavailable.",
        ],
      },
      {
        heading: "Limitation of Liability",
        paragraphs: [
          // REVIEW(legal): limitation clause and its enforceability; the cap previously published was "the fees you paid for the relevant course".
          "Nothing in these terms limits any right you have under Indian consumer protection law. To the extent the law allows, GloryTecks is not liable for indirect or consequential losses arising from your use of the website or a course, and our total liability for a course is limited to the fees you paid for it.",
        ],
      },
      {
        heading: "Governing Law",
        paragraphs: [
          // REVIEW(legal): jurisdiction clause (the previous text said "exclusive jurisdiction").
          "These terms are governed by the laws of India. Disputes are subject to the jurisdiction of the courts at Hyderabad, Telangana.",
        ],
      },
      {
        heading: "Changes to These Terms",
        paragraphs: [
          "We may update these terms; the version on this page applies from its \"Last updated\" date. The terms confirmed with you at enrolment continue to apply to that enrolment.",
        ],
      },
      contactSection,
    ],
  },

  /* ── Refund Policy ────────────────────────────────────────────────────── */
  {
    slug: "refund-policy",
    title: "Refund Policy",
    metaTitle: "Refund Policy | GloryTecks IT Training Institute Hyderabad",
    metaDescription:
      "How refund, cancellation and batch-transfer requests for GloryTecks courses are handled, and how to make a request.",
    updated: REVISION_DATE,
    intro:
      "This page explains how refund, cancellation and batch-transfer requests for GloryTecks courses are handled and how to make one.",
    sections: [
      {
        heading: "Free Demo First",
        paragraphs: [
          // REVIEW(business): confirm a free demo class is available for every course.
          "You can attend a free demo class before you enrol, so you can judge the trainer, the course content and the teaching style before you pay.",
        ],
      },
      {
        heading: "Terms for Your Enrolment",
        paragraphs: [
          // REVIEW(business): replace this section with the approved rules — refund window, any deduction, pro-rata rules, transfer rules — once decided. Do not publish numbers before they are approved.
          "The refund, cancellation and batch-transfer terms that apply to your enrolment are the ones confirmed with you in writing before you pay. If you have not received them, ask us for them before paying.",
        ],
      },
      {
        heading: "How to Request a Refund or Transfer",
        paragraphs: [
          // REVIEW(business): add the processing time and payment method for approved refunds once confirmed.
          `Contact us at ${EMAIL} or ${PHONE} with your name, the course and batch, and the date and method of your payment. We will confirm that we have received your request and tell you the outcome, including, for an approved refund, how and when it will be paid.`,
        ],
      },
      contactSection,
    ],
  },

  /* ── Cookie Policy ────────────────────────────────────────────────────── */
  {
    slug: "cookie-policy",
    title: "Cookie Policy",
    metaTitle: "Cookie Policy | GloryTecks IT Training Institute Hyderabad",
    metaDescription:
      "The cookies and similar technologies the GloryTecks website uses — Google Analytics and embedded Google content — and how to block them.",
    updated: REVISION_DATE,
    intro:
      "This policy explains the cookies and similar technologies used on the GloryTecks website, what they do and how you can control them. Please read it together with our Privacy Policy.",
    sections: [
      {
        heading: "What Are Cookies?",
        paragraphs: [
          "Cookies are small text files a website stores on your device. They help a site remember information between pages and visits and understand how it is used. A website can also keep information in your browser's session storage, which is cleared when you close the tab.",
        ],
      },
      {
        heading: "Cookies We Use",
        paragraphs: [
          // REVIEW(business): re-check this list whenever a tag is added in Google Tag Manager or the Content-Security-Policy changes (container GTM-TD5HFZ79 held only a Microsoft Clarity tag on 2026-10-16, which the CSP blocks).
          "The website does not need cookies of its own to work: you do not sign in to use it. The cookies on this site come from Google Analytics, which it loads on every page:",
        ],
        bullets: [
          "Google Analytics 4: the _ga cookie and a second cookie whose name starts with _ga_, both on our domain, which tell visitors and their sessions apart. Google states they last up to two years by default.",
        ],
      },
      {
        heading: "Embedded Content",
        paragraphs: [
          "Google Maps maps on several pages and the YouTube video on the home page are loaded from Google, which may set its own cookies when that content loads, under Google's policies.",
        ],
      },
      {
        heading: "Information Stored in Your Browser",
        paragraphs: [
          "The chat assistant keeps your conversation in your browser's session storage so it continues as you move between pages; it is cleared when you close the tab. A similar session flag remembers that you have already seen our pop-up during the visit.",
        ],
      },
      {
        heading: "Consent & Control",
        paragraphs: [
          // REVIEW(legal): consent for analytics cookies — this site has no consent mechanism yet; see the implementation dependency in the review doc.
          // D1: if the legacy consent banner is restored before publishing, rewrite this paragraph to describe it.
          "Google Analytics and the embedded content start when you open a page. This website does not currently show a cookie banner or offer an on-site setting to switch them off. You can block or delete cookies in your browser settings, browse in a private window, or install Google's Google Analytics Opt-out Browser Add-on. Blocking cookies may stop some embedded content from working.",
        ],
      },
      {
        heading: "Changes to This Policy",
        paragraphs: [
          "We update this policy, and its \"Last updated\" date, when the tools we use change.",
        ],
      },
      contactSection,
    ],
  },

  /* ── Disclaimer ───────────────────────────────────────────────────────── */
  {
    slug: "disclaimer",
    title: "Disclaimer",
    metaTitle: "Disclaimer | GloryTecks IT Training Institute Hyderabad",
    metaDescription:
      "The limits of the information on the GloryTecks website: no promise of jobs, salaries or results, educational content, certificates, links and trademarks.",
    updated: REVISION_DATE,
    intro:
      "The information on this website is provided for general educational and informational purposes. Please read the following carefully.",
    sections: [
      {
        heading: "No Promise of Jobs or Results",
        paragraphs: [
          "GloryTecks provides training and, for some courses, placement assistance. We do not promise a job, a particular employer, a salary, a placement rate or any other result. Results depend on each learner's effort, skills and interview performance, and on the job market.",
        ],
      },
      {
        heading: "Certificates",
        paragraphs: [
          // REVIEW(business): confirm who issues course certificates and what they are called.
          "Any course certificate we issue shows that you completed a GloryTecks course. Unless it says otherwise, it is not a qualification recognised by a university, a government body or any employer.",
        ],
      },
      {
        heading: "Educational Information Only",
        paragraphs: [
          "Articles, salary figures, market trends and career timelines on this website are general information. Salary and market figures are indicative estimates based on published surveys and other public sources. None of it is professional, financial or career advice, and it can go out of date.",
        ],
      },
      {
        heading: "Accuracy",
        paragraphs: [
          "We work to keep the website accurate, but course details, schedules, fees and other information can change. Please confirm anything important with us before relying on it.",
        ],
      },
      {
        heading: "External Links",
        paragraphs: [
          "Our website and blog link to third-party websites and tools for your convenience. We do not control and are not responsible for their content, accuracy or availability.",
        ],
      },
      {
        heading: "Trademarks",
        paragraphs: [
          "Technology names, logos and brands mentioned on this site (for example Python, Power BI, AWS, Azure and GCP) belong to their respective owners and are used only to describe what we teach.",
        ],
      },
      contactSection,
    ],
  },

  /* ── Editorial Policy ─────────────────────────────────────────────────── */
  {
    slug: "editorial-policy",
    title: "Editorial & Content Policy",
    metaTitle: "Editorial Policy | GloryTecks IT Training Institute Hyderabad",
    metaDescription:
      "How GloryTecks prepares, checks, dates and corrects the articles on its blog, including how AI writing tools are used.",
    updated: REVISION_DATE,
    intro:
      "GloryTecks publishes learning guides, roadmaps, interview questions and career articles. This policy explains how they are prepared, checked and kept up to date.",
    sections: [
      {
        heading: "Who Writes Our Content",
        paragraphs: [
          // REVIEW(business): before showing a named author on an article, confirm the person and their stated role.
          "Our articles are published under the \"GloryTecks Team\" byline: they are the work of GloryTecks rather than of one named person. Each article shows its publication date and the date it was last updated.",
        ],
      },
      {
        heading: "How We Use AI Tools",
        paragraphs: [
          // REVIEW(business): approve this disclosure and confirm who checks drafts before publication.
          "We use AI writing tools to help research and draft articles. Drafts are checked before publication, including against the sources listed in the article, and code examples are run to confirm they work.",
        ],
      },
      {
        heading: "Accuracy & Sources",
        bullets: [
          "Most articles end with a Sources section listing the references used.",
          "Salary and market figures are indicative ranges, not promises.",
          "Where a topic changes quickly (for example generative AI tools), details can go out of date; check the official documentation for the current version.",
        ],
      },
      {
        heading: "Content Update Policy",
        paragraphs: [
          "When we find that an article is out of date or inaccurate, we revise it. A revised article shows its new \"Updated\" date, and our sitemaps report the same date to search engines.",
        ],
      },
      {
        heading: "Corrections",
        paragraphs: [
          // REVIEW(business): confirm the mailbox and the commitment to review reports.
          `To report an error, email ${EMAIL} with the article's address and what is wrong. We will review it and, if we agree, correct the article and update its date.`,
        ],
      },
      contactSection,
    ],
  },
];

export const legalSlugs = legalDocs.map((d) => d.slug);
export const findLegalDoc = (slug?: string) => legalDocs.find((d) => d.slug === slug);
