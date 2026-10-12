/**
 * Brand header.
 *
 * Top of the page is the site's NAME banner (public/img/image.png,
 * "DpBOSSSS.COM") - a SMALL centered logo on a slim peach strip,
 * like the reference site's top strip. The image keeps its natural
 * aspect ratio (max-width capped, height auto) so it never becomes
 * a giant full-width block.
 * Below it sits the original welcome bar:
 *   live-matka-laxmi.jpg  - 90x68  "Live Matka LAXMI_PICTURE"
 */
export default function Header() {
  return (
    <>
      {/* Site-name banner (DpBOSSSS.COM) - small centered logo on a slim strip. */}
      <div
        style={{
          marginBottom: '2px',
          padding: '6px 10px',
          textAlign: 'center',
          backgroundColor: '#fc9',
          borderRadius: '10px',
          border: '2px solid #ff182c',
          boxShadow: '0 0 20px 0 rgb(0 0 0 / 40%)',
        }}
      >
        <img
          src="/img/image.png"
          alt="dpboosssss.com - Satta Matka Fast Result"
          width="1024"
          height="332"
          style={{
            display: 'inline-block',
            width: 'auto',
            maxWidth: 'min(320px, 80%)',
            height: 'auto',
            maxHeight: '60px',
          }}
        />
      </div>
      <div
        style={{
          marginBottom: '1px',
          display: 'flex',
          padding: '5px',
          alignItems: 'center',
          justifyContent: 'space-between',
          borderRadius: '10px',
          border: '2px solid #ff182c',
          boxShadow: '0 0 20px 0 rgb(0 0 0 / 40%)',
        }}
      >
        <img
          src="/img/live-matka-laxmi.jpg"
          alt="Live Matka LAXMI_PICTURE"
          width="90"
          height="68"
        />
        <p style={{ color: 'black', display: 'inline-block', fontSize: '16px' }}>
          !! Welcome to Live Matka international !! Satta Matka Fast Result
        </p>
      </div>
    </>
  );
}
