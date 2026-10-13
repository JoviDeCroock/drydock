import keyvLogo from "../../assets/keyv-logo.svg";
import cacheableLogo from "../../assets/cacheable-logo.svg";
import preactLogo from "../../assets/preact-logo.svg";
import { AikidoFootnote } from "../../components/AikidoPartner";

const projects = [
  {
    name: "Keyv",
    href: "https://keyv.org",
    logo: keyvLogo,
    width: 1420,
    height: 540,
    size: "h-5",
  },
  {
    name: "Cacheable",
    href: "https://cacheable.org",
    logo: cacheableLogo,
    width: 1330,
    height: 730,
    size: "h-7",
  },
  {
    name: "Preact",
    href: "https://preactjs.com",
    logo: preactLogo,
    width: 1800,
    height: 512,
    size: "h-5",
  },
];

export function LandingTrustStrip() {
  return (
    <section
      aria-label="Drydock sponsor and projects"
      class="flex flex-col sm:flex-row items-center justify-center gap-3 sm:gap-8"
    >
      <AikidoFootnote />
      <div class="flex items-center gap-4">
        <span id="landing-used-by" class="text-[13px] text-ink-muted">
          Used by
        </span>
        <ul aria-labelledby="landing-used-by" class="list-none m-0 p-0 flex items-center gap-4">
          {projects.map((project) => (
            <li key={project.name}>
              <a
                href={project.href}
                target="_blank"
                rel="noopener noreferrer"
                class="inline-flex items-center opacity-70 hover:opacity-100 focus-visible:opacity-100 transition-opacity duration-150 ease-out rounded-sm focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-accent"
              >
                <img
                  src={project.logo}
                  alt={project.name}
                  width={project.width}
                  height={project.height}
                  decoding="async"
                  class={`w-auto brightness-0 dark:invert ${project.size}`}
                />
              </a>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
