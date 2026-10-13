import keyvLogo from "../../assets/keyv-logo.svg";
import cacheableLogo from "../../assets/cacheable-logo.svg";
import preactLogo from "../../assets/preact-logo.svg";
import { SectionLabel } from "../../components/Typography";

const projects = [
  {
    name: "Keyv",
    href: "https://keyv.org",
    logo: keyvLogo,
    width: 1420,
    height: 540,
    size: "h-10",
  },
  {
    name: "Cacheable",
    href: "https://cacheable.org",
    logo: cacheableLogo,
    width: 1330,
    height: 730,
    size: "h-14",
  },
  {
    name: "Preact",
    href: "https://preactjs.com",
    logo: preactLogo,
    width: 1800,
    height: 512,
    size: "h-10",
  },
];

export function UsedBy() {
  return (
    <section aria-label="Projects using Drydock" class="flex flex-col gap-4">
      <SectionLabel as="p">Used by</SectionLabel>
      <ul class="list-none m-0 p-0 self-center flex flex-wrap items-center justify-center gap-8 md:gap-12">
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
    </section>
  );
}
