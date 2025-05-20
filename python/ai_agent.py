import sys
import os
import pandas as pd
import requests
from bs4 import BeautifulSoup
import re
import time
import json
import random
import logging
from typing import Dict, List, Optional, Tuple

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger(__name__)

# API configuration
API_KEY = os.getenv('DEEPSEEK_API_KEY', '')
if not API_KEY:
    logger.error("Missing DEEPSEEK_API_KEY environment variable")
    sys.exit(1)

DEEPSEEK_API_URL = "https://api.deepseek.com"
DEEPSEEK_MODEL = "deepseek-chat"
MAX_RETRIES = 3
REQUEST_TIMEOUT = 20  # seconds

def extract_domain(url: str) -> str:
    """Extract the domain from a URL."""
    url = url.strip()
    if not url.startswith(('http://', 'https://')):
        url = 'https://' + url
    
    try:
        domain = url.split('//')[1].split('/')[0]
        return domain
    except IndexError:
        return url

def clean_url(url: str) -> str:
    """Ensure URL has proper format."""
    url = url.strip()
    if not url.startswith(('http://', 'https://')):
        url = 'https://' + url
    return url

def scrape_website(url: str) -> Tuple[Optional[str], Optional[str], Optional[str]]:
    """Scrape a website with retries and timeout handling."""
    for attempt in range(MAX_RETRIES):
        try:
            url = clean_url(url)
            headers = {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
            }
            
            response = requests.get(
                url, 
                headers=headers, 
                timeout=REQUEST_TIMEOUT,
                allow_redirects=True
            )
            response.raise_for_status()
            
            soup = BeautifulSoup(response.text, 'html.parser')
            
            # Extract email
            email_pattern = r'\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b'
            emails = re.findall(email_pattern, response.text)
            email = emails[0] if emails else None
            
            # Extract phone number
            phone_pattern = r'\b(?:\+\d{1,3}[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}\b'
            phones = re.findall(phone_pattern, response.text)
            phone = phones[0] if phones else None
            
            # Extract about text
            about_text = ""
            meta_desc = soup.find('meta', attrs={'name': 'description'})
            if meta_desc and meta_desc.get('content'):
                about_text += meta_desc.get('content') + " "
            
            about_section = soup.find('section', id=re.compile(r'about', re.I)) or \
                            soup.find('div', id=re.compile(r'about', re.I)) or \
                            soup.find('div', class_=re.compile(r'about', re.I))
            
            if about_section:
                about_text += " ".join([p.text for p in about_section.find_all('p')])
            else:
                main_content = soup.find('main') or soup.find('article') or soup.body
                if main_content:
                    paragraphs = main_content.find_all('p', limit=5)
                    about_text += " ".join([p.text for p in paragraphs])
            
            about_text = re.sub(r'\s+', ' ', about_text).strip()
            about_text = about_text[:1000]  # Limit length
            
            return email, phone, about_text
            
        except Exception as e:
            if attempt == MAX_RETRIES - 1:
                logger.error(f"Failed to scrape {url} after {MAX_RETRIES} attempts: {str(e)}")
                return None, None, None
            time.sleep(2 ** attempt)  # Exponential backoff

def generate_outreach_message(website: str, about_text: str) -> str:
    """Generate message with proper error handling."""
    try:
        if not about_text or len(about_text) < 50:
            about_text = f"This is for {website}, but I couldn't extract much information about them."
        
        prompt = f"""
        Create a personalized cold outreach email message for the website {website}.
        
        About the business:
        {about_text}
        
        The message should:
        - Be 3-4 paragraphs, professional but conversational in tone
        - Include a brief introduction and reason for reaching out
        - Reference specific elements from their business/website
        - Suggest a potential collaboration or service that would benefit them
        - Include a clear call to action
        - Have a professional sign-off
        - Be about 150-200 words total
        - DO NOT include email subject line or greeting
        """
        
        headers = {
            "Content-Type": "application/json",
            "Authorization": f"Bearer {API_KEY}"
        }
        
        payload = {
            "model": DEEPSEEK_MODEL,
            "messages": [
                {"role": "system", "content": "You are a helpful assistant that generates personalized outreach messages."},
                {"role": "user", "content": prompt}
            ],
            "temperature": 0.7,
            "max_tokens": 500
        }
        
        response = requests.post(
            f"{DEEPSEEK_API_URL}/v1/chat/completions",
            headers=headers,
            json=payload,
            timeout=30
        )
        response.raise_for_status()
        
        outreach_message = response.json()["choices"][0]["message"]["content"].strip()
        
        if not outreach_message or len(outreach_message) < 50:
            raise ValueError("API returned empty or short message")
            
        return outreach_message
        
    except Exception as e:
        logger.error(f"Error generating message for {website}: {str(e)}")
        return f"""
        I recently discovered {website} and wanted to reach out because I believe our services could be valuable to your business. 
        
        We help companies like yours improve their online presence and generate more qualified leads through targeted digital marketing strategies.
        
        Would you be open to a quick conversation to explore if there might be a good fit? I'd be happy to share some ideas specific to your industry.
        
        Best regards,
        """.strip()

def main():
    if len(sys.argv) != 3:
        print(json.dumps({"error": "Usage: python ai_agent.py <input_file> <output_file>"}))
        sys.exit(1)
    
    input_file = sys.argv[1]
    output_file = sys.argv[2]
    
    try:
        # Read input file
        df = pd.read_excel(input_file)
        if df.empty:
            raise ValueError("Excel file is empty")
        
        first_col = df.columns[0]
        urls = df[first_col].tolist()
        
        results = []
        processed_count = 0
        contacts_found = 0
        
        for url in urls:
            if not isinstance(url, str):
                continue
                
            processed_count += 1
            logger.info(f"Processing {url} ({processed_count}/{len(urls)})")
            
            domain = extract_domain(url)
            email, phone, about_text = scrape_website(url)
            
            if email or phone:
                contacts_found += 1
            
            outreach_message = generate_outreach_message(domain, about_text) if about_text else ""
            
            results.append({
                'Website': url,
                'Domain': domain,
                'Email': email or "",
                'Phone': phone or "",
                'About Text': about_text or "",
                'Outreach Message': outreach_message
            })
            
            time.sleep(random.uniform(1, 3))
        
        # Save results
        pd.DataFrame(results).to_excel(output_file, index=False)
        
        # Output stats
        stats = {
            "processedCount": processed_count,
            "contactsFound": contacts_found
        }
        print(json.dumps(stats))
        sys.exit(0)
        
    except Exception as e:
        logger.error(f"Error: {str(e)}")
        print(json.dumps({"error": str(e)}))
        sys.exit(1)

if __name__ == "__main__":
    main()