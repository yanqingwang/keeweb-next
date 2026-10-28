import { expect } from 'chai';
import { MdToHtml } from 'util/formatting/md-to-html';

describe('MdToHtml', () => {
    it('should convert markdown', () => {
        expect(MdToHtml.convert('## head\n_italic_')).to.eql({
            html: '<div class="markdown"><h2>head</h2>\n<p><em>italic</em></p>\n</div>'
        });
    });

    it('should not add markdown wrapper tags for plaintext', () => {
        expect(MdToHtml.convert('plain\ntext')).to.eql({ text: 'plain\ntext' });
    });

    it('should convert links', () => {
        const { html } = MdToHtml.convert('[link](https://x)');
        const root = document.createElement('div');
        root.innerHTML = html;
        const link = root.querySelector('a');
        // attribute order is up to the sanitizer, the values are what matters
        expect(link.getAttribute('href')).to.equal('https://x');
        expect(link.getAttribute('target')).to.equal('_blank');
        expect(link.getAttribute('rel')).to.equal('noreferrer noopener');
        expect(link.textContent).to.equal('link');
        expect(root.querySelector('.markdown p a')).to.equal(link);
    });
});
