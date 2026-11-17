(() => {
  const toggle = document.querySelector(".menu-toggle");
  const nav = document.querySelector("#primary-nav");
  if (!toggle || !nav) return;

  const mobileQuery = window.matchMedia("(max-width: 680px)");
  const links = [...nav.querySelectorAll("a")];

  const closeMenu = ({ returnFocus = false } = {}) => {
    nav.classList.remove("is-open");
    toggle.setAttribute("aria-expanded", "false");
    toggle.setAttribute("aria-label", "Открыть меню");
    document.body.classList.remove("menu-open");
    if (returnFocus) toggle.focus();
  };

  const openMenu = () => {
    nav.classList.add("is-open");
    toggle.setAttribute("aria-expanded", "true");
    toggle.setAttribute("aria-label", "Закрыть меню");
    document.body.classList.add("menu-open");
    links[0]?.focus();
  };

  toggle.addEventListener("click", () => {
    toggle.getAttribute("aria-expanded") === "true" ? closeMenu() : openMenu();
  });

  links.forEach((link) => link.addEventListener("click", () => closeMenu()));

  document.addEventListener("click", (event) => {
    if (toggle.getAttribute("aria-expanded") !== "true") return;
    if (!nav.contains(event.target) && !toggle.contains(event.target)) closeMenu();
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && toggle.getAttribute("aria-expanded") === "true") {
      event.preventDefault();
      closeMenu({ returnFocus: true });
    }

    if (event.key === "Tab" && toggle.getAttribute("aria-expanded") === "true") {
      const focusable = [toggle, ...links];
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }
  });

  mobileQuery.addEventListener("change", (event) => {
    if (!event.matches) closeMenu();
  });

  const sections = links
    .map((link) => document.querySelector(link.getAttribute("href")))
    .filter(Boolean);

  if ("IntersectionObserver" in window) {
    const observer = new IntersectionObserver((entries) => {
      entries.forEach((entry) => {
        if (!entry.isIntersecting) return;
        const activeLink = links.find((link) => link.getAttribute("href") === `#${entry.target.id}`);
        links.forEach((link) => link.removeAttribute("aria-current"));
        activeLink?.setAttribute("aria-current", "location");
      });
    }, { rootMargin: "-25% 0px -65% 0px" });

    sections.forEach((section) => observer.observe(section));
  }
})();
