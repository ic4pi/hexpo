from PIL import Image
# 8-column palette strip matching the Kenney city-kit UV layout used by the
# uploaded models: u snaps to 8 discrete columns, v is a free vertical ramp.
# Colors are pulled from the game's own neon palette in game.html.
COLS = [
    ("walls",     (0x4a,0x2a,0x6b), (0x15,0x0a,0x24)),  # 0 building walls, path
    ("foliage",   (0x5b,0xe2,0xc4), (0x10,0x32,0x2e)),  # 1 tree canopy, trim
    ("dark",      (0x2a,0x22,0x33), (0x07,0x05,0x09)),  # 2 tyres, character
    ("primary",   (0xff,0x2d,0x87), (0x6b,0x0a,0x30)),  # 3 vehicle body (magenta)
    ("wood",      (0xd9,0xa4,0x41), (0x4a,0x32,0x11)),  # 4 fence, trunk (brass)
    ("accent",    (0xa5,0x6b,0xff), (0x33,0x11,0x6b)),  # 5 debris, kart (purple)
    ("highlight", (0xf0,0xc4,0x6b), (0x7a,0x54,0x18)),  # 6 warm highlight
    ("accent2",   (0x22,0xd3,0xee), (0x0a,0x45,0x51)),  # 7 cyan accent
]
W,H,N = 512,512,8
cw = W//N
img = Image.new("RGB",(W,H))
px = img.load()
for i,(name,top,bot) in enumerate(COLS):
    for y in range(H):
        t = y/(H-1)
        c = tuple(int(top[k]+(bot[k]-top[k])*t) for k in range(3))
        for x in range(i*cw,(i+1)*cw):
            px[x,y]=c
img.save("assets/kit/Textures/colormap.png")
print("wrote colormap.png", img.size)
