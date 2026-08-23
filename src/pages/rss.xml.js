import { getRssString } from '@astrojs/rss';

// Source of truth for the feed is duplicated from each post's own frontmatter
// (title/description/publishDateISO) rather than imported, since posts live as
// individual .astro pages, not a content collection. If a new post is added to
// src/pages/blog.astro, add its metadata here too so it appears in the feed.
const posts = [
  { slug: 'atlanta-mixed-use-architectural-model-installation', title: 'Installing an 8-Foot Mixed-Use Architectural Model in Atlanta', description: 'CARVE fabricated and installed an 8 × 8 × 6-foot, 1:96 scale mixed-use development model in Atlanta, designing a modular build to move through restricted elevator access and assemble on-site.', pubDate: new Date('2026-08-21') },
  { slug: 'new-carve-model-website-launch', title: 'The New Carve Model Website Is Live', description: 'Carve Model launched its new website on August 21, 2026, with clearer service information, project guidance, and updates on the Carve Studio Portal.', pubDate: new Date('2026-08-21') },
  { slug: 'from-ai-generated-image-to-physical-model', title: 'From AI-Generated Image to Physical Model', description: 'An AI-generated image can establish a compelling design direction, but it rarely contains everything required for fabrication. Learn what additional information and decisions are needed to turn a generated concept into a physical model.', pubDate: new Date('2026-08-11') },
  { slug: 'architectural-model-packaging-shipping-installation', title: 'How Architectural Models Are Packaged, Shipped and Installed', description: 'Successful delivery begins before fabrication. Learn how model dimensions, sectional construction, protective packaging, building access, and on-site setup are coordinated for safe transportation and installation.', pubDate: new Date('2026-08-11') },
  { slug: 'how-to-prepare-an-architectural-model-brief', title: 'How to Prepare a Brief for an Architectural Model', description: 'A clear architectural model brief begins with purpose, audience, boundaries, dimensions, available files, and delivery requirements. Use this checklist to prepare the information needed for an initial review.', pubDate: new Date('2026-08-11') },
  { slug: 'why-physical-verification-matters-in-digital-design', title: 'Why Physical Verification Matters as Digital Design Becomes More Abundant', description: 'As digital and AI-assisted tools create more design possibilities, the challenge shifts from generating options to evaluating them. Learn how physical models provide tangible evidence for clearer, more confident decisions.', pubDate: new Date('2026-08-11') },
  { slug: 'physical-models-vs-renderings-animation-ar-vr', title: 'Physical Models, Renderings, Animation, AR and VR: What Each Communicates Best', description: 'Physical models, renderings, animation, AR, and VR communicate different aspects of a design. Learn which medium is best for atmosphere, sequence, immersion, real-world context, and shared spatial understanding—and when they work best together.', pubDate: new Date('2026-08-11') },
  { slug: 'carve-model-aia26-conference', title: 'Carve Model at AIA26 in San Diego', description: 'Carve Model attended the AIA Conference on Architecture & Design 2026 in San Diego to meet architects, explore emerging design and fabrication technologies, and hear how firms are adapting as digital and AI-assisted design continues to evolve.', pubDate: new Date('2026-06-16') },
  { slug: 'how-to-choose-architectural-model-scale', title: 'How to Choose the Right Scale for an Architectural Model', description: 'The right scale is determined by what the model needs to communicate, how much detail it must show, and how large the finished model can practically be.', pubDate: new Date('2026-04-22') },
  { slug: 'architectural-scale-model-cost-us', title: 'How Much Does an Architectural Scale Model Cost?', description: "Architectural models are custom-built, so their cost depends on the project's purpose, size, detail, source information, features, and delivery requirements.", pubDate: new Date('2026-04-02') },
  { slug: 'how-long-to-build-architectural-model', title: 'How Long Does It Take to Build an Architectural Scale Model?', description: 'Most architectural models require approximately two to four weeks of production after the scope, design information, and key specifications have been confirmed.', pubDate: new Date('2026-03-18') },
  { slug: 'types-of-architectural-scale-models', title: 'Types of Architectural Models and What Each Is Used For', description: 'Architectural models can support different stages of design, approval, construction, presentation, and documentation. The right type depends on what the audience needs to understand.', pubDate: new Date('2026-03-04') },
];

export async function GET(context) {
  const xml = await getRssString({
    title: 'Carve Model Blog',
    description: 'Guides and insights on architectural scale models — scope, scale, materials, timelines, and delivery — from Carve Model.',
    site: context.site,
    items: posts.map((p) => ({
      title: p.title,
      description: p.description,
      pubDate: p.pubDate,
      link: `/blog/${p.slug}/`,
    })),
    customData: `<language>en-us</language>`,
  });
  // @astrojs/rss's own Response defaults to Content-Type: application/xml;
  // the previous feed served application/rss+xml, so build the Response
  // manually here to preserve that exact content type for existing readers.
  return new Response(xml, {
    headers: { 'Content-Type': 'application/rss+xml; charset=utf-8' },
  });
}
