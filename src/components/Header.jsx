/**
 * Brand header.
 *
 * Top of the page is the site's NAME banner (public/img/image.png,
 * "DpBOSSSS.COM") - displayed FULL WIDTH inside its red-bordered box,
 * edge to edge, exactly like the reference site's top strip. The image
 * keeps its natural aspect ratio (width 100%, height auto).
 * Below it sits the original welcome bar:
 *   live-matka-laxmi.jpg  - 90x68  "Live Matka LAXMI_PICTURE"
 */
export default function Header() {
  return (
    <>
      {/* Site-name banner (DpBOSSSS.COM) - the website's brand, full width. */}
      <div
        style={{
          marginBottom: '2px',
          overflow: 'hidden',
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
            display: 'block',
            width: '100%',
            height: 'auto',
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
